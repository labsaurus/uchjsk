#!/usr/bin/env bash
# One-shot installer for Debian/Ubuntu. Run as root from the repository's crawler/ directory.
set -euo pipefail

APP_DIR=/opt/playstore-crawler
APP_USER=crawler

id "$APP_USER" &>/dev/null || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR"
cp -r package.json package-lock.json src migrations seeds deploy README.md .env.example "$APP_DIR"/
[ -f "$APP_DIR/.env" ] || cp .env.example "$APP_DIR/.env"
chmod 600 "$APP_DIR/.env"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

cd "$APP_DIR"
sudo -u "$APP_USER" npm ci --omit=dev --no-audit --no-fund

cp deploy/systemd/playstore-crawler.service deploy/systemd/playstore-crawler.timer /etc/systemd/system/
systemctl daemon-reload

echo
echo "Next steps:"
echo "  1. Edit $APP_DIR/.env (DATABASE_URL, USER_AGENT with a contact address)"
echo "  2. sudo -u $APP_USER bash -c 'cd $APP_DIR && node src/cli.js migrate'"
echo "  3. sudo -u $APP_USER bash -c 'cd $APP_DIR && node src/cli.js seed seeds/example.txt'"
echo "  4. systemctl enable --now playstore-crawler.timer"
