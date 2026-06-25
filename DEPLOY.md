# Subir el álbum a Vercel (GitHub + panel)

El proyecto ya está listo: frontend + API de cuentas (`/api`) + base de datos Redis.
Seguí estos pasos una sola vez.

## 1) Subir a GitHub

Ya dejé el repo Git inicializado y con el primer commit. Solo falta enviarlo a GitHub:

1. Entrá a https://github.com/new y creá un repo **vacío** (ej. `album-mundial-2026`). **No** marques "Add README".
2. Copiá los comandos que GitHub te muestra para "push an existing repository", o usá estos (reemplazá la URL):

```bash
cd "album-mundial-2026"
git remote add origin https://github.com/TU_USUARIO/album-mundial-2026.git
git branch -M main
git push -u origin main
```

## 2) Importar en Vercel

1. Entrá a https://vercel.com/new
2. Elegí el repo `album-mundial-2026` → **Import**.
3. **Framework Preset**: *Other* (lo detecta solo). No toques Build/Output.
4. Click **Deploy**. (Va a fallar el login del álbum hasta el paso 3 — es normal.)

## 3) Crear la base de datos (Upstash Redis, gratis)

En el proyecto recién creado, en Vercel:

1. Pestaña **Storage** → **Create Database** → **Upstash for Redis** (Marketplace) → plan **Free**.
2. **Connect** la base a este proyecto.
   → Vercel agrega solas las variables `KV_REST_API_URL` y `KV_REST_API_TOKEN` (o `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN`). El código entiende cualquiera de las dos.

## 4) Agregar el secreto de sesión

En **Settings → Environment Variables** del proyecto, agregá:

| Name | Value |
|---|---|
| `AUTH_SECRET` | *(te lo paso en el chat — un texto largo aleatorio)* |

## 5) Redeploy

Pestaña **Deployments** → en el último deploy, menú **⋯ → Redeploy** (así toma las variables nuevas).

Listo: abrí la URL de Vercel, creá tu cuenta con nombre + PIN, y cada persona que entre tendrá su propio álbum.

---

### Notas
- Las cuentas usan **nombre + PIN** (el PIN se guarda **hasheado**, no en texto plano).
- El **progreso** (qué figuritas tenés, repes, nombres de equipos editados) se guarda en tu cuenta y se sincroniza entre dispositivos.
- Las **fotos propias** que subas (cámara/importar) se guardan **en ese dispositivo** (no se sincronizan), para no llenar la base.
