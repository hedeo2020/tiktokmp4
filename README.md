# TikTok HD Video Compressor

A small production-oriented website that accepts a public TikTok URL, fetches HD metadata through TikWMAPI on the backend, downloads the HD source temporarily, compresses it with FFmpeg, and returns a small MP4.

The default target is about 1 MB for every 20 seconds. That is a very low bitrate, so adaptive resolution usually looks better than forcing 1080p.

## Features

- Backend-only TikWMAPI key.
- `POST /api/video/info` metadata endpoint.
- `POST /api/video/download` MP4 download endpoint.
- FFmpeg two-pass H.264 compression.
- Adaptive and keep-up-to-1080p modes.
- Streamed source downloads with source-size limits.
- TikTok URL validation.
- Private/reserved IP blocking for HD source downloads.
- Rate limiting, Helmet, small request body limit, and one-job concurrency default.
- Temporary file cleanup.
- Docker and Nginx deployment files.

## Legal Notice

Download only videos you own or have permission to use. You are responsible for complying with copyright law, privacy rules, TikTok's terms, and local regulations.

## Local Installation

Install Node.js 20 or newer, then install dependencies:

```bash
npm install
```

Install FFmpeg:

```bash
sudo apt update
sudo apt install -y ffmpeg
ffmpeg -version
ffprobe -version
```

Create your environment file:

```bash
cp .env.example .env
```

Edit `.env` and set:

```bash
TIKWM_API_KEY=your_key_here
```

Run in development:

```bash
npm run dev
```

Open:

```text
http://localhost:3000
```

## Production Build

```bash
npm run build
npm start
```

## Tests

```bash
npm test
```

## Docker Compose

```bash
docker compose up -d --build
docker compose logs -f
```

## Install Docker On Ubuntu

```bash
sudo apt update
sudo apt install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

## Nginx Setup

Install Nginx:

```bash
sudo apt update
sudo apt install -y nginx
```

Copy `nginx.conf` to a site config, update `server_name`, then enable it:

```bash
sudo cp nginx.conf /etc/nginx/sites-available/tiktok-compressor
sudo ln -s /etc/nginx/sites-available/tiktok-compressor /etc/nginx/sites-enabled/tiktok-compressor
sudo nginx -t
sudo systemctl reload nginx
```

## HTTPS With Certbot

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.example
```

## Oracle Cloud Networking

Open ingress ports 80 and 443 in the Oracle Cloud security list or network security group for the VPS subnet.

Configure the Ubuntu firewall:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
sudo ufw status
```

## Swap File

A small Oracle Free Tier VPS benefits from swap during compression:

```bash
sudo fallocate -l 4G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

## Logs

With Docker Compose:

```bash
docker compose logs -f
```

With a plain Node process under systemd:

```bash
journalctl -u tiktok-compressor -f
```

## Cleaning Temporary Files

The app removes each job directory after success, failure, timeout, or browser disconnect. It also removes abandoned job directories older than two hours on startup.

Manual cleanup:

```bash
sudo rm -rf /tmp/tiktok-compressor/job-*
```

## Updating

```bash
git pull
npm install
npm run build
sudo systemctl restart tiktok-compressor
```

For Docker:

```bash
git pull
docker compose up -d --build
```

## Environment Variables

```text
PORT=3000
TIKWM_API_BASE=https://api.tikwmapi.com
TIKWM_API_KEY=replace_this
MAX_DURATION_SECONDS=180
MAX_SOURCE_SIZE_MB=500
MAX_CONCURRENT_JOBS=1
TEMP_DIRECTORY=/tmp/tiktok-compressor
JOB_TIMEOUT_SECONDS=600
RATE_LIMIT_REQUESTS=60
RATE_LIMIT_WINDOW_MINUTES=15
FFMPEG_THREADS=1
```

In Coolify, set these as environment variables. If you see rate-limit messages while testing, increase `RATE_LIMIT_REQUESTS`; only `/api` requests are counted.

## API

### `POST /api/video/info`

```json
{
  "url": "https://www.tiktok.com/@user/video/123"
}
```

### `POST /api/video/download`

```json
{
  "url": "https://www.tiktok.com/@user/video/123",
  "mode": "adaptive",
  "sizePer20SecondsMb": 1
}
```

Supported modes:

- `adaptive`
- `keep-1080p`
