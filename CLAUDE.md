# sit-ciit-mobile

## Resumen

App Expo/React Native de SIT-CIIT. Los "nodos de campo" del sistema son
celulares Android reales usando `expo-sensors`/`expo-location` — no hay
hardware dedicado. Esta app tiene dos modos, en pestañas (`app/(tabs)/`):

- **Nodo**: lee sensores, detecta eventos en el borde, guarda todo primero
  en SQLite (outbox) y lo envía por MQTT cuando hay red.
- **Operador**: login contra `sit-ciit-backend`, alertas en vivo por
  Socket.IO, botones `trigger_alarm`/`stop_alarm`.

Un mismo celular puede ser nodo backup *y* operador a la vez (ambas
pestañas activas simultáneamente).

El usuario que maneja este repo es nuevo en Expo — explica brevemente
cualquier concepto nuevo de Expo/RN la primera vez que aparezca (en
comentarios cortos o en el README), sin exceso.

## Restricciones del proyecto (aplican a todo SIT-CIIT)

- **Sin hardware dedicado**: los sensores son los del celular real. Nunca
  generar lecturas falsas — si un sensor no está disponible
  (`isAvailableAsync`), se omite de `capabilities`, no se inventa.
  Los tests unitarios sí pueden usar fixtures.
- La arquitectura debe permitir sustituir el celular por un ESP32 después
  sin rediseñar: toda la lógica de sensores/outbox debe hablar el mismo
  contrato MQTT, sin acoplarse a APIs específicas de Expo más allá de la
  capa de adquisición.
- Probar primero en **Expo Go**; pasar a development build solo si una
  dependencia lo exige (código nativo no incluido en Expo Go).
- Fuera del MVP (solo documentar): Bluetooth cel↔cel, SMS desde el
  celular, LoRa, satelital, ejecución en segundo plano.

## Contrato

- Fuente de verdad: `sit-ciit-infra/contracts/`. Copia local en
  `src/contract/contract.ts` (no editar ahí, correr
  `sit-ciit-infra/scripts/sync-contract.sh`).
- Tópicos: `sitciit/{nodeId}/telemetry|event|heartbeat|cmd|ack`, QoS 1.
  Conectar con `clientId` = `nodeId` estable y `clean: false`.

## Riesgo conocido: mqtt.js + React Native

mqtt.js puede requerir polyfills de `Buffer`/`process`/`url` (típicamente
vía `metro.config.js` + paquetes como `react-native-buffer`/`stream-browserify`).
Resolver esto es parte de la **Fase 1** (punta a punta mínima). Si tras
intentarlo no queda estable, **detenerse y proponer alternativa** (WebSocket
simple contra un endpoint del backend, o Socket.IO) antes de cambiar el
diseño general — no improvisar un workaround frágil.

## Detección en el borde (Fase 2)

- `impact`: √(x²+y²+z²) del acelerómetro > umbral (default 2.5 g, configurable).
- `door_open`/`door_closed`: lux por encima/debajo de umbral, histéresis +
  debounce de 1 s.
- `rollover`: ángulo del vector de gravedad vs. vertical > 60° sostenido 2 s.

## Outbox / store-and-forward (Fase 3)

Todo mensaje saliente se escribe primero en SQLite (`expo-sqlite`), se
envía en orden de `seq` cuando hay conexión (NetInfo + estado del cliente
MQTT), y se borra solo tras confirmación QoS 1. Mostrar el tamaño de la
cola en pantalla.

## Nota: expo-doctor marca expo-av como no mantenido

`expo-av` (usado para el sonido de alarma) aparece como "Unmaintained" en
`npx expo-doctor`. Se mantiene por ahora porque el usuario lo pidió
explícitamente en el plan original. Si al implementar la alarma (Fase 2)
da problemas, avisar antes de cambiarlo por `expo-audio` (su sucesor
recomendado por Expo) — es un cambio de dependencia, no decidirlo solo.

## Comandos útiles

```bash
npm install
npx expo start          # abrir con Expo Go en un Android real
npx expo install <pkg>  # SIEMPRE así para libs con módulo nativo, no npm/yarn/pnpm add
npx tsc --noEmit
npx expo lint
npx expo-doctor
```

## Cosas a NO hacer

- No generar telemetría de sensor falsa para "probar sin celular" — si se
  necesita probar el envío MQTT sin sensores reales, usar `mosquitto_pub`
  a mano desde `sit-ciit-infra` con un payload real según el contrato, no
  un generador dentro de esta app.
- No implementar ejecución en segundo plano en el MVP (pantalla debe
  mantenerse encendida con `expo-keep-awake`).
- No crear `ios/`/`android/` a mano: se generan (Continuous Native
  Generation); configurar comportamiento nativo en `app.json`.
