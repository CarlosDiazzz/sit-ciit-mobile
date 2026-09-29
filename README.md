# sit-ciit-mobile

App Expo (React Native) para **SIT-CIIT**. Un mismo celular puede correr en
**modo Nodo** (sensores + outbox MQTT) o **modo Operador** (alertas y
control remoto), en pestañas.

Requiere `sit-ciit-infra` corriendo (Mosquitto) y, para modo Operador,
`sit-ciit-backend` corriendo.

## Setup

```bash
npm install
npx expo start
```

Escanea el QR con **Expo Go** (Android) para probar en el celular real —
necesitamos sensores reales (acelerómetro, GPS, luz), así que un emulador
sirve para ver la UI pero no para probar la detección de eventos.

## Notas para quien es nuevo en Expo

- **Expo Router**: cada archivo en `app/` es una pantalla; `_layout.tsx`
  define cómo se agrupan (aquí, `app/(tabs)/_layout.tsx` define las dos
  pestañas Nodo/Operador). No hay que configurar navegación a mano.
- **Expo Go** es la app que instalas en tu celular para probar sin
  compilar un binario nativo — sirve mientras solo usemos librerías con
  módulo nativo ya incluido en Expo Go (sensores, ubicación, SQLite, etc.
  sí lo están). Si una dependencia necesita código nativo que Expo Go no
  trae, hay que pasar a un *development build* (`npx expo run:android`) —
  evitarlo mientras se pueda, según indica `CLAUDE.md`.
- **`app.json`** es la configuración de la app (nombre, ícono, permisos).
  Los permisos de sensores/GPS se agregan ahí cuando se implementen.

## Estructura

```
app/
  (tabs)/nodo.tsx        modo Nodo (placeholder, Fase 1+)
  (tabs)/operador.tsx    modo Operador (placeholder, Fase 6)
src/contract/contract.ts copia sincronizada desde sit-ciit-infra
```

## Riesgo conocido: mqtt.js en React Native

`mqtt` (mqtt.js) puede necesitar polyfills de `Buffer`/`process`/`url` para
correr en React Native. Se resuelve en la Fase 1, junto con la primera
conexión real al broker. Si no queda estable, la alternativa (WebSocket
simple o Socket.IO) se decide ahí antes de seguir — ver `CLAUDE.md`.
