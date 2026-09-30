// AUTO-GENERADO por sit-ciit-infra/scripts/sync-contract.sh
// Copiado de sit-ciit-infra/contracts/contract.ts — version 1.3.0
// No editar aquí: editar la fuente de verdad y volver a correr el script.

// SIT-CIIT — Contrato de mensajes v1.3.0
// Fuente de verdad. NO editar copias en otros repos: usar scripts/sync-contract.sh
// desde sit-ciit-infra para propagar cambios.

export const CONTRACT_VERSION = "1.3.0";

// ---------------------------------------------------------------------------
// Tipos compartidos
// ---------------------------------------------------------------------------

export type NodeRole = "primary" | "backup";
export type MessageType = "telemetry" | "event" | "heartbeat" | "ack";

export interface Vector3 {
  x: number;
  y: number;
  z: number;
}

export interface GpsCoords {
  lat: number;
  lon: number;
}

export interface GpsReading extends GpsCoords {
  speedMs?: number;
  accuracyM?: number;
}

// ---------------------------------------------------------------------------
// Sobre común — nodo -> nube (telemetry, event, heartbeat, ack)
// ---------------------------------------------------------------------------

export interface Envelope {
  contractVersion: string;
  /** UUID v4, usado para deduplicar en el backend (UNIQUE constraint). */
  msgId: string;
  nodeId: string;
  unitId: string;
  role: NodeRole;
  /** Secreto emitido al dar de alta el nodo (CRUD de Nodos en el
   *  dashboard, rol control_center). El backend lo verifica contra el
   *  hash guardado antes de aceptar cualquier mensaje — sin esto,
   *  cualquiera podía declararse dueño de cualquier nodeId con solo
   *  escribirlo (v1.3.0). */
  nodeSecret: string;
  /** Consecutivo por nodo, permite reordenar tras reconexión. */
  seq: number;
  /** epoch ms, reloj del dispositivo (hora real del evento, no de envío). */
  ts: number;
  type: MessageType;
}

// ---- telemetry --------------------------------------------------------

export interface TelemetryPayload {
  /** en g */
  accel?: Vector3;
  /** rad/s */
  gyro?: Vector3;
  /** microtesla (µT), lectura cruda — no es rumbo/brújula. Calcular
   *  rumbo requiere compensar inclinación con el acelerómetro y
   *  calibración; queda fuera del MVP (ver roadmap). */
  mag?: Vector3;
  lux?: number;
  pressureHpa?: number;
  gps?: GpsReading;
}

export type TelemetryMessage = Envelope & { type: "telemetry" } & TelemetryPayload;

// ---- event --------------------------------------------------------------

export type EventKind =
  | "impact"
  | "door_open"
  | "door_closed"
  | "rollover"
  | "threshold_exceeded"
  // --- Dinámica de marcha (v1.2.0) -------------------------------------
  // Detectados en el nodo a partir de la aceleración dinámica |a - g_ref|
  // descompuesta en vertical y horizontal. No requieren saber la
  // orientación del dispositivo: la gravedad da la referencia.
  /** Frenado brusco. `value` = desaceleración longitudinal en g. */
  | "hard_brake"
  /** Curva tomada con exceso de aceleración lateral.
   *  `value` = aceleración lateral en g. */
  | "curve_overspeed"
  /** Golpe con su eje identificado (vertical: vía o junta; horizontal:
   *  acoplamiento). `value` = magnitud dinámica en g. */
  | "dynamic_impact"
  /** Oscilación vertical sostenida: posible defecto de vía.
   *  `value` = amplitud en g. */
  | "track_irregularity";

export type EventSeverity = "info" | "warning" | "critical";

export interface EventPayload {
  kind: EventKind;
  severity: EventSeverity;
  /** magnitud medida */
  value?: number;
  /** umbral aplicado */
  threshold?: number;
  gps?: GpsCoords;
}

export type EventMessage = Envelope & { type: "event" } & EventPayload;

// ---- heartbeat ------------------------------------------------------------

export type NodeMode = "normal" | "inspection" | "alarm";

export interface HeartbeatPayload {
  batteryPct?: number;
  /** mensajes en cola local (SQLite outbox) sin enviar */
  pendingOutbox: number;
  samplingMs: number;
  /** sensores disponibles en este dispositivo, ej. ["accelerometer","gps","light"] */
  capabilities: string[];
  mode: NodeMode;
}

export type HeartbeatMessage = Envelope & { type: "heartbeat" } & HeartbeatPayload;

// ---- ack (confirmación de comando) ----------------------------------------

export type AckStatus = "delivered" | "executed" | "rejected";

export interface AckPayload {
  cmdId: string;
  status: AckStatus;
  reason?: string;
}

export type AckMessage = Envelope & { type: "ack" } & AckPayload;

/** Unión de todos los mensajes que un nodo publica hacia la nube. */
export type NodeToCloudMessage =
  | TelemetryMessage
  | EventMessage
  | HeartbeatMessage
  | AckMessage;

// ---------------------------------------------------------------------------
// Comando — nube -> nodo. No usa el Envelope común (dirección opuesta).
// ---------------------------------------------------------------------------

export type CmdAction =
  | "set_sampling_rate"
  | "set_thresholds"
  | "trigger_alarm"
  | "stop_alarm"
  | "set_mode"
  | "toggle_sensor";

export type IssuerRole = "control_center" | "operator";

export interface CmdMessage {
  contractVersion: string;
  /** UUID v4 */
  cmdId: string;
  targetNodeId: string;
  issuedBy: {
    userId: string;
    role: IssuerRole;
  };
  action: CmdAction;
  params: Record<string, unknown>;
  issuedAt: number;
}

// ---------------------------------------------------------------------------
// Reglas de autoridad (documentadas aquí para referencia cruzada de código)
// ---------------------------------------------------------------------------
// - control_center: puede ejecutar cualquier CmdAction.
// - operator: solo trigger_alarm y stop_alarm.
// - Comandos contradictorios: gana el más reciente emitido por control_center.
// - El backend valida autoridad antes de publicar; el nodo revalida y
//   responde ack.status = "rejected" con reason si no corresponde.

/** Acciones permitidas para el rol "operator". */
export const OPERATOR_ALLOWED_ACTIONS: readonly CmdAction[] = [
  "trigger_alarm",
  "stop_alarm",
];

export function isActionAllowedForRole(action: CmdAction, role: IssuerRole): boolean {
  if (role === "control_center") return true;
  return (OPERATOR_ALLOWED_ACTIONS as CmdAction[]).includes(action);
}
