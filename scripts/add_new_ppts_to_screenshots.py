#!/usr/bin/env python3
"""Add newly supplied PPT/PPTX files to a Gemini PPT screenshot set.

The script appends new deckNN folders under DeckSync/shots,
converts PPT/PPTX -> PDF with PowerPoint or LibreOffice, rasterizes PDF -> PNG
with Poppler or pypdfium2, and appends entries to manifest.json. It
intentionally does not edit gemini_progress.json.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path


class CommandError(RuntimeError):
    pass


def env_path(name: str) -> Path | None:
    value = os.environ.get(name, "").strip().strip('"')
    return Path(value) if value else None


def env_choice(name: str, default: str, choices: set[str]) -> str:
    value = os.environ.get(name, "").strip().lower()
    return value if value in choices else default


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Append new PPT/PPTX decks to DeckSync/shots."
    )
    parser.add_argument(
        "--workspace",
        type=Path,
        default=Path.cwd(),
        help="Course workspace containing PPT/PPTX files. Defaults to cwd.",
    )
    parser.add_argument(
        "--root",
        type=Path,
        default=None,
        help="Screenshot root. Defaults to <workspace>/DeckSync/shots.",
    )
    parser.add_argument(
        "--ppt",
        action="append",
        type=Path,
        default=[],
        help="PPT/PPTX file to append. Repeat for multiple files. If omitted, auto-detect files newer than the existing screenshot set.",
    )
    parser.add_argument(
        "--scale-to-x",
        type=int,
        default=1800,
        help="PNG width for pdftoppm. Existing Java screenshots use 1800.",
    )
    parser.add_argument(
        "--soffice",
        type=Path,
        default=env_path("GEMSYNC_SOFFICE"),
        help="Path to soffice.exe. Defaults to PATH or common Windows install paths.",
    )
    parser.add_argument(
        "--ppt-converter",
        choices=["auto", "powerpoint", "libreoffice"],
        default=env_choice(
            "GEMSYNC_PPT_CONVERTER",
            "auto",
            {"auto", "powerpoint", "libreoffice"},
        ),
        help="PPT/PPTX to PDF converter. auto prefers Microsoft PowerPoint on Windows and falls back to LibreOffice.",
    )
    parser.add_argument(
        "--pdftoppm",
        type=Path,
        default=env_path("GEMSYNC_PDFTOPPM"),
        help="Path to pdftoppm/pdftoppm.exe. Defaults to PATH or common Windows Poppler install paths.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the planned additions without converting or writing files.",
    )
    parser.add_argument(
        "--allow-duplicate-source",
        action="store_true",
        help="Allow a PPT/PPTX whose file name is already present in manifest.json.",
    )
    return parser.parse_args()


def resolve_tool(explicit: Path | None, names: list[str], common: list[Path]) -> Path:
    if explicit:
        path = explicit.expanduser().resolve()
        if path.exists():
            return path
        raise SystemExit(f"Tool not found: {path}")

    for name in names:
        found = shutil.which(name)
        if found:
            return Path(found)

    for path in common:
        if path.exists():
            return path

    raise SystemExit(
        "Missing required tool. Install it, add it to PATH, or pass the tool path explicitly."
    )


def resolve_optional_tool(
    explicit: Path | None, names: list[str], common: list[Path]
) -> Path | None:
    try:
        return resolve_tool(explicit, names, common)
    except SystemExit as error:
        print(f"WARN optional tool unavailable: {error}")
        return None


def find_optional_tool(
    explicit: Path | None, names: list[str], common: list[Path]
) -> Path | None:
    try:
        return resolve_tool(explicit, names, common)
    except SystemExit:
        return None


def load_manifest(path: Path) -> list[dict]:
    if not path.exists():
        return []
    text = path.read_text(encoding="utf-8-sig")
    data = json.loads(text)
    if not isinstance(data, list):
        if isinstance(data, dict) and isinstance(data.get("decks"), list):
            migrated: list[dict] = []
            for order, item in enumerate(data["decks"], start=1):
                if not isinstance(item, dict):
                    continue
                migrated.append(
                    {
                        "order": order,
                        "deckIndex": item.get("deckIndex")
                        or item.get("deck")
                        or item.get("folder")
                        or order,
                        "source": item.get("source")
                        or item.get("title")
                        or item.get("folder")
                        or "",
                        "path": item.get("path") or "",
                    }
                )
            return migrated
        raise SystemExit(f"Expected manifest list at {path}")
    return data


def existing_deck_indexes(root: Path, manifest: list[dict]) -> set[int]:
    indexes = {
        int(item["deckIndex"])
        for item in manifest
        if isinstance(item, dict) and str(item.get("deckIndex", "")).isdigit()
    }
    if root.exists():
        for entry in root.iterdir():
            if entry.is_dir():
                match = re.match(r"deck(\d+)_", entry.name)
                if match and any(entry.glob("*.png")):
                    indexes.add(int(match.group(1)))
    return indexes


def latest_existing_mtime(root: Path, manifest_path: Path) -> float:
    mtimes: list[float] = []
    if manifest_path.exists():
        mtimes.append(manifest_path.stat().st_mtime)
    if root.exists():
        for entry in root.iterdir():
            if entry.is_dir() and re.match(r"deck\d+_", entry.name):
                mtimes.append(entry.stat().st_mtime)
    return max(mtimes, default=0.0)


def sort_key_for_ppt(path: Path) -> tuple[int, str]:
    match = re.search(r"Lesson[_\s-]*(\d+)", path.stem, flags=re.IGNORECASE)
    lesson = int(match.group(1)) if match else 10_000
    return lesson, path.name.lower()


def source_key(name: str) -> str:
    return re.sub(r"[\s_-]+", "", Path(str(name)).stem.lower())


def path_key(path_value: str | Path) -> str:
    return str(Path(path_value).expanduser().resolve()).casefold()


def manifest_source_path_keys(manifest: list[dict]) -> set[str]:
    keys: set[str] = set()
    for item in manifest:
        if not isinstance(item, dict):
            continue
        source_path = str(item.get("sourcePath", "")).strip()
        if source_path:
            keys.add(path_key(source_path))
    return keys


def screened_name_allowances(manifest: list[dict]) -> dict[str, int]:
    allowances: dict[str, int] = {}
    seen: set[str] = set()
    for item in manifest:
        if not isinstance(item, dict) or item.get("sourcePath"):
            continue
        source = str(item.get("source", "")).strip()
        key = source_key(source)
        if not key:
            continue
        deck_key = str(item.get("deckIndex") or item.get("deck") or item.get("folder") or source)
        unique = f"{deck_key}:{key}"
        if unique in seen:
            continue
        seen.add(unique)
        allowances[key] = allowances.get(key, 0) + 1
    return allowances


def unscreened_ppts_from_manifest(ppts: list[Path], manifest: list[dict]) -> list[Path]:
    exact_paths = manifest_source_path_keys(manifest)
    allowances = screened_name_allowances(manifest)
    unscreened: list[Path] = []
    for ppt in ppts:
        if path_key(ppt) in exact_paths:
            continue
        key = source_key(ppt.name)
        allowance = allowances.get(key, 0)
        if allowance > 0:
            allowances[key] = allowance - 1
            continue
        unscreened.append(ppt)
    return unscreened


def should_skip_source_dir(path: Path) -> bool:
    name = path.name.lower()
    return name in {
        "gemini_ppt_screenshots_full",
        "DeckSync",
        "chrome-gemini-automation-profile",
        "chrome-chatgpt-automation-profile",
        "node_modules",
        ".git",
    }


def workspace_ppts(workspace: Path) -> list[Path]:
    ppts: list[Path] = []
    for path in workspace.rglob("*"):
        if path.is_dir() and should_skip_source_dir(path):
            # pathlib.rglob cannot prune in-place, so descendants are filtered below too.
            continue
        if not path.is_file() or path.suffix.lower() not in {".ppt", ".pptx"}:
            continue
        if path.name.startswith("~$"):
            continue
        try:
            relative_parts = path.relative_to(workspace).parts[:-1]
        except ValueError:
            relative_parts = ()
        if any(part.lower() in {
            "gemini_ppt_screenshots_full",
            "DeckSync",
            "chrome-gemini-automation-profile",
            "chrome-chatgpt-automation-profile",
            "node_modules",
            ".git",
        } for part in relative_parts):
            continue
        ppts.append(path)
    return ppts


def auto_detect_ppts(
    workspace: Path, root: Path, manifest_path: Path, manifest: list[dict]
) -> list[Path]:
    cutoff = latest_existing_mtime(root, manifest_path)
    ppts = workspace_ppts(workspace)
    candidates = unscreened_ppts_from_manifest(ppts, manifest)
    if not candidates:
        candidates = [path for path in ppts if path.stat().st_mtime > cutoff]
    return sorted(candidates, key=sort_key_for_ppt)


def sanitize_stem(stem: str) -> str:
    safe = re.sub(r"[()\[\]{}]", "_", stem)
    safe = re.sub(r"[^\w\u4e00-\u9fff]+", "_", safe, flags=re.UNICODE)
    safe = re.sub(r"_+", "_", safe).strip("_")
    return safe or "PPT"


def run(command: list[str]) -> None:
    print("RUN", " ".join(command))
    try:
        completed = subprocess.run(command, check=False)
    except OSError as error:
        raise CommandError(f"Command could not start: {error}") from error
    if completed.returncode != 0:
        raise CommandError(f"Command failed with exit code {completed.returncode}")


def powershell_executable() -> str | None:
    return shutil.which("powershell.exe") or shutil.which("powershell")


def convert_to_pdf_with_powerpoint(ppt: Path, pdf_dir: Path, pdf_stem: str) -> Path:
    if sys.platform != "win32":
        raise CommandError("PowerPoint automation is only available on Windows")

    powershell = powershell_executable()
    if not powershell:
        raise CommandError("PowerShell is not available for PowerPoint automation")

    pdf_dir.mkdir(parents=True, exist_ok=True)
    pdf_path = pdf_dir / f"{pdf_stem}.pdf"
    if pdf_path.exists():
        pdf_path.unlink()

    script = r"""
param(
  [Parameter(Mandatory=$true)][string]$InputPath,
  [Parameter(Mandatory=$true)][string]$OutputPath
)
$ErrorActionPreference = 'Stop'
$powerPoint = $null
$presentation = $null
try {
  $powerPoint = New-Object -ComObject PowerPoint.Application
  try { $powerPoint.DisplayAlerts = 1 } catch {}
  $presentation = $powerPoint.Presentations.Open($InputPath, $true, $false, $false)
  $presentation.SaveAs($OutputPath, 32)
} finally {
  if ($presentation -ne $null) {
    try { $presentation.Close() } catch {}
    [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($presentation)
  }
  if ($powerPoint -ne $null) {
    try { $powerPoint.Quit() } catch {}
    [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($powerPoint)
  }
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
}
if (!(Test-Path -LiteralPath $OutputPath)) {
  throw "PowerPoint did not create PDF: $OutputPath"
}
"""

    with tempfile.NamedTemporaryFile(
        "w",
        suffix=".ps1",
        delete=False,
        encoding="utf-8-sig",
    ) as handle:
        handle.write(script)
        script_path = Path(handle.name)

    try:
        run(
            [
                powershell,
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(script_path),
                "-InputPath",
                str(ppt),
                "-OutputPath",
                str(pdf_path),
            ]
        )
    finally:
        script_path.unlink(missing_ok=True)

    return pdf_path


def convert_to_pdf_with_libreoffice(
    ppt: Path, pdf_dir: Path, profile_dir: Path, soffice: Path, pdf_stem: str
) -> Path:
    pdf_dir.mkdir(parents=True, exist_ok=True)
    profile_dir.mkdir(parents=True, exist_ok=True)
    profile_uri = profile_dir.resolve().as_uri()
    with tempfile.TemporaryDirectory(prefix=f"{pdf_stem}_", dir=pdf_dir) as tmp_dir:
        tmp_pdf_dir = Path(tmp_dir)
        run(
            [
                str(soffice),
                f"-env:UserInstallation={profile_uri}",
                "--headless",
                "--nologo",
                "--nofirststartwizard",
                "--convert-to",
                "pdf",
                "--outdir",
                str(tmp_pdf_dir),
                str(ppt),
            ]
        )
        generated_pdf = tmp_pdf_dir / f"{ppt.stem}.pdf"
        if not generated_pdf.exists():
            raise SystemExit(f"Converted PDF was not created: {generated_pdf}")
        pdf_path = pdf_dir / f"{pdf_stem}.pdf"
        if pdf_path.exists():
            pdf_path.unlink()
        generated_pdf.replace(pdf_path)
        return pdf_path


def convert_to_pdf(
    ppt: Path,
    pdf_dir: Path,
    profile_dir: Path,
    pdf_stem: str,
    converter: str,
    soffice: Path | None,
) -> Path:
    if converter in {"auto", "powerpoint"}:
        try:
            print(f"CONVERT PowerPoint {ppt.name}")
            return convert_to_pdf_with_powerpoint(ppt, pdf_dir, pdf_stem)
        except CommandError as error:
            if converter == "powerpoint":
                raise
            print(f"WARN PowerPoint conversion failed, falling back to LibreOffice: {error}")

    if not soffice:
        raise CommandError("LibreOffice is not available for PPT/PPTX conversion")

    print(f"CONVERT LibreOffice {ppt.name}")
    return convert_to_pdf_with_libreoffice(ppt, pdf_dir, profile_dir, soffice, pdf_stem)


def rasterize_pdf_with_pdfium(
    pdf_path: Path,
    out_dir: Path,
    deck_prefix: str,
    scale_to_x: int,
) -> list[Path]:
    try:
        import pypdfium2 as pdfium
    except ImportError as error:
        raise SystemExit(
            "pdftoppm failed and pypdfium2 is not installed in this Python. "
            "Install pypdfium2 or run with file-python."
        ) from error

    print("FALLBACK pypdfium2")
    pdf = pdfium.PdfDocument(str(pdf_path))
    slide_paths: list[Path] = []
    try:
        for index in range(len(pdf)):
            page = pdf[index]
            try:
                width, _height = page.get_size()
                scale = scale_to_x / width if width else 2
                bitmap = page.render(scale=scale)
                image = bitmap.to_pil()
                target = out_dir / f"{deck_prefix}_slide{index + 1:03d}.png"
                image.save(target)
                image.close()
                slide_paths.append(target)
            finally:
                page.close()
    finally:
        pdf.close()

    if not slide_paths:
        raise SystemExit(f"No PNGs were produced for {pdf_path}")
    return slide_paths


def rasterize_pdf(
    pdf_path: Path,
    out_dir: Path,
    deck_prefix: str,
    pdftoppm: Path | None,
    scale_to_x: int,
) -> list[Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    existing_pngs = list(out_dir.glob("*.png"))
    if existing_pngs:
        raise SystemExit(f"Refusing to write into non-empty deck folder: {out_dir}")

    tmp_prefix = out_dir / "tmp_slide"
    if pdftoppm:
        try:
            run(
                [
                    str(pdftoppm),
                    "-png",
                    "-scale-to-x",
                    str(scale_to_x),
                    "-scale-to-y",
                    "-1",
                    str(pdf_path),
                    str(tmp_prefix),
                ]
            )
        except CommandError as error:
            print(f"WARN pdftoppm failed, falling back to pypdfium2: {error}")
            for partial in out_dir.glob("tmp_slide-*.png"):
                partial.unlink(missing_ok=True)
            return rasterize_pdf_with_pdfium(pdf_path, out_dir, deck_prefix, scale_to_x)
    else:
        print("WARN pdftoppm unavailable, falling back to pypdfium2")
        return rasterize_pdf_with_pdfium(pdf_path, out_dir, deck_prefix, scale_to_x)

    tmp_files = sorted(
        out_dir.glob("tmp_slide-*.png"),
        key=lambda p: int(re.search(r"-(\d+)\.png$", p.name).group(1)),
    )
    if not tmp_files:
        raise SystemExit(f"No PNGs were produced for {pdf_path}")

    slide_paths: list[Path] = []
    for index, tmp in enumerate(tmp_files, start=1):
        target = out_dir / f"{deck_prefix}_slide{index:03d}.png"
        tmp.replace(target)
        slide_paths.append(target)
    return slide_paths


def append_manifest(
    manifest_path: Path,
    manifest: list[dict],
    deck_index: int,
    source_path: Path,
    workspace: Path,
    slide_paths: list[Path],
) -> None:
    if manifest_path.exists():
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        backup = manifest_path.with_name(
            f"manifest.backup-before-add-ppts-{stamp}.json"
        )
        shutil.copy2(manifest_path, backup)
        print(f"BACKUP {backup}")

    next_order = max((int(item.get("order", 0)) for item in manifest), default=0) + 1
    total = len(slide_paths)
    source_name = source_path.name
    try:
        source_relative_path = str(source_path.resolve().relative_to(workspace.resolve()))
    except ValueError:
        source_relative_path = source_name
    for slide_num, slide_path in enumerate(slide_paths, start=1):
        manifest.append(
            {
                "order": next_order,
                "deckIndex": deck_index,
                "source": source_name,
                "sourcePath": str(source_path.resolve()),
                "sourceRelativePath": source_relative_path,
                "slide": slide_num,
                "totalSlidesInDeck": total,
                "path": str(slide_path.resolve()),
                "bytes": slide_path.stat().st_size,
            }
        )
        next_order += 1

    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )


def main() -> int:
    args = parse_args()
    workspace = args.workspace.expanduser().resolve()
    root = (
        args.root.expanduser().resolve()
        if args.root
        else workspace / "DeckSync" / "shots"
    )
    manifest_path = root / "manifest.json"
    pdf_dir = root / "_pdf"

    manifest = load_manifest(manifest_path)
    ppts = [path.expanduser().resolve() for path in args.ppt]
    if not ppts:
        ppts = auto_detect_ppts(workspace, root, manifest_path, manifest)

    if not ppts:
        print("No new PPT/PPTX files detected. Pass --ppt explicitly if needed.")
        return 0

    for ppt in ppts:
        if not ppt.exists() or ppt.suffix.lower() not in {".ppt", ".pptx"}:
            raise SystemExit(f"Invalid PPT/PPTX path: {ppt}")

    if not args.allow_duplicate_source:
        workspace_unscreened = unscreened_ppts_from_manifest(workspace_ppts(workspace), manifest)
        unscreened = set(workspace_unscreened)
        duplicates = [str(ppt) for ppt in ppts if ppt not in unscreened]
        if duplicates:
            names = ", ".join(duplicates)
            raise SystemExit(
                f"These PPT/PPTX files already exist in manifest.json: {names}. "
                "Use --allow-duplicate-source only if the duplicate is intentional."
            )

    indexes = existing_deck_indexes(root, manifest)
    next_index = max(indexes, default=0) + 1
    plan = []
    for offset, ppt in enumerate(ppts):
        deck_index = next_index + offset
        deck_prefix = f"deck{deck_index:02d}"
        folder = root / f"{deck_prefix}_{sanitize_stem(ppt.stem)}"
        plan.append((deck_index, deck_prefix, ppt, folder))

    print("PLAN")
    for deck_index, _deck_prefix, ppt, folder in plan:
        print(f"  deck{deck_index:02d}: {ppt.name} -> {folder}")

    if args.dry_run:
        return 0

    soffice_common = [
        Path(r"C:\Program Files\LibreOffice\program\soffice.exe"),
        Path(r"C:\Program Files (x86)\LibreOffice\program\soffice.exe"),
    ]
    if args.ppt_converter == "libreoffice":
        soffice = resolve_tool(
            args.soffice,
            ["soffice", "soffice.exe", "libreoffice"],
            soffice_common,
        )
    elif args.soffice:
        soffice = resolve_tool(
            args.soffice,
            ["soffice", "soffice.exe", "libreoffice"],
            soffice_common,
        )
    else:
        soffice = find_optional_tool(
            None,
            ["soffice", "soffice.exe", "libreoffice"],
            soffice_common,
        )
    pdftoppm = resolve_optional_tool(
        args.pdftoppm,
        ["pdftoppm", "pdftoppm.exe"],
        [
            Path(r"C:\Program Files\poppler\Library\bin\pdftoppm.exe"),
            Path(r"C:\poppler\Library\bin\pdftoppm.exe"),
        ],
    )

    root.mkdir(parents=True, exist_ok=True)
    for deck_index, deck_prefix, ppt, folder in plan:
        profile = root / f"_lo_profile_{deck_index:02d}"
        pdf_stem = f"{deck_prefix}_{sanitize_stem(ppt.stem)}"
        pdf_path = convert_to_pdf(
            ppt,
            pdf_dir,
            profile,
            pdf_stem,
            args.ppt_converter,
            soffice,
        )
        slides = rasterize_pdf(
            pdf_path, folder, deck_prefix, pdftoppm, args.scale_to_x
        )
        append_manifest(manifest_path, manifest, deck_index, ppt, workspace, slides)
        print(f"DONE {folder.name} slides={len(slides)}")

    print("gemini_progress.json was not modified.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except CommandError as error:
        raise SystemExit(str(error))
