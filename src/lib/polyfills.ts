// mqtt.js (vía su build de React Native, dist/mqtt.esm.js) y uuid esperan
// globals que Node trae por defecto pero React Native no: Buffer, process,
// y crypto.getRandomValues (para generar UUIDs v4 de msgId/cmdId).
// Debe importarse antes que cualquier código que use mqtt/uuid — por eso
// se importa primero en app/_layout.tsx.
import { Buffer } from 'buffer';
import process from 'process';
import 'react-native-get-random-values';

if (typeof (global as any).Buffer === 'undefined') {
  (global as any).Buffer = Buffer;
}

if (typeof (global as any).process === 'undefined') {
  (global as any).process = process;
}
