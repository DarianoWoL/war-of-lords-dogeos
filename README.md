Strategic Game - Minimal dev setup

Quick start (requires Docker & Docker Compose):

1. Copy your `tło.png` and `mapa.png` into `public/assets/` (create the folder).
2. Build and run:

```bash
docker-compose up --build
```

Server: http://localhost:3000
Client: http://localhost:3000/

Auth endpoints:
- POST /api/register { username, password }
- POST /api/login { username, password }

Admin account: username `Dariano`, password from `.env` or `ADMIN_PASSWORD` (default `Najemnik412`).
