/* Un solo socket compartido hacia sit-ciit-backend para alertas en vivo
 * y avances de comando — igual que sit-ciit-dashboard/src/api/socket.ts:
 * mismo backend, mismo contrato de eventos, autenticado con el mismo
 * JWT que ya usan las llamadas REST de src/lib/api.ts.
 */

import { io, type Socket } from 'socket.io-client';

/** Reemision de un evento recien guardado (impacto/puerta/volcadura del
 *  dispositivo, o signal_lost/weather_risk/etc. generados por el
 *  backend). unitId/nodeId son codigos del contrato, ts es epoch ms —
 *  ver sit-ciit-backend/src/domain/ports/TelemetryBroadcaster.ts. */
export interface EventBroadcast {
  unitId: string;
  nodeId: string | null;
  kind: string;
  severity: 'info' | 'warning' | 'critical';
  value?: number;
  threshold?: number;
  gps?: { lat: number; lon: number };
  ts: number;
}

export interface CommandUpdate {
  cmdId: string;
  nodeId: string;
  status: 'delivered' | 'executed' | 'rejected';
  reason: string | null;
  occurredAt: number;
}

let socket: Socket | null = null;
let socketUrl: string | null = null;
let socketToken: string | null = null;

/** Reutiliza el socket si ya esta abierto con la misma URL/token; si
 *  cambia cualquiera de los dos (otro backend, otro login), cierra el
 *  anterior en vez de dejarlo huerfano emitiendo con credenciales viejas. */
export function getOperatorSocket(apiUrl: string, token: string): Socket {
  if (socket && socketUrl === apiUrl && socketToken === token) return socket;
  socket?.close();
  socketUrl = apiUrl;
  socketToken = token;
  socket = io(apiUrl, {
    autoConnect: true,
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10000,
    auth: (cb) => cb({ token }),
  });
  return socket;
}

export function closeOperatorSocket(): void {
  socket?.close();
  socket = null;
  socketUrl = null;
  socketToken = null;
}
