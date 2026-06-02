#!/bin/zsh
set -e

cd "$(dirname "$0")/.."

echo "Checking Node.js..."
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20+ is required."
  echo "Install with Homebrew: brew install node"
  exit 1
fi

NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])")"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Node.js 20+ is required. Current: $(node -v)"
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required. Reinstall Node.js if npm is missing."
  exit 1
fi

if [ ! -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ] && ! command -v google-chrome >/dev/null 2>&1; then
  echo "Warning: Google Chrome was not found. Install it with: brew install --cask google-chrome"
fi

if ! command -v pdfinfo >/dev/null 2>&1 || ! command -v pdftoppm >/dev/null 2>&1; then
  echo "Warning: Poppler was not found. PDF screenshots need it. Install with: brew install poppler"
fi

if ! command -v soffice >/dev/null 2>&1 && [ ! -x "/Applications/LibreOffice.app/Contents/MacOS/soffice" ]; then
  echo "Warning: LibreOffice was not found. PPT/PPTX conversion may need it. Install with: brew install --cask libreoffice"
fi

echo "Installing app dependencies..."
npm install

echo "Checking code..."
npm run check

echo ""
echo "Setup finished. Double-click start.command to run DeckSync."
