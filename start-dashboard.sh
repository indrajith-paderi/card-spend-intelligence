#!/bin/sh
cd "$(dirname "$0")/app" || exit 1

if command -v python3 >/dev/null 2>&1; then
  exec python3 serve.py "$@"
elif command -v python >/dev/null 2>&1; then
  exec python serve.py "$@"
fi

echo "Python 3 is needed to run the dashboard."
echo "On Ubuntu or Debian: sudo apt install python3"
echo "On Fedora: sudo dnf install python3"
exit 1
