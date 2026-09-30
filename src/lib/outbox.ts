/* Cola de salida persistente (store-and-forward).
 *
 * El corredor tiene tramos sin cobertura. Hasta ahora, un mensaje
 * generado sin conexión se descartaba en silencio: `publishEvent`
 * devolvía temprano si el cliente MQTT no estaba conectado, así que un
 * impacto dentro de un túnel se perdía para siempre.
 *
 * Aquí todo mensaje saliente se escribe primero en SQLite y se borra
 * solo cuando el broker confirma la entrega (QoS 1). Si la app se cierra
 * o el teléfono se apaga, la cola sigue ahí al volver.
 *
 * Lo importante es que el `ts` original se conserva: el mensaje viaja
 * con la hora en que ocurrió, no con la del envío. El backend guarda
 * ambas y el dashboard marca el retraso — así un evento sincronizado
 * dos horas después no aparece como si acabara de pasar.
 */

import * as SQLite from 'expo-sqlite';

/** Tope de la cola. A 1 Hz son unas 5 horas de telemetría; pasado eso
 *  se descartan los más viejos para no llenar el almacenamiento del
 *  teléfono. Los eventos nunca se descartan (ver `encolar`). */
const MAX_FILAS = 20_000;

/** Cuántos mensajes se envían por tanda al recuperar la conexión.
 *  Vaciar 5 000 de golpe satura el broker y la interfaz. */
const LOTE = 25;

export type TipoMensaje = 'telemetry' | 'event' | 'heartbeat' | 'ack';

export interface MensajePendiente {
  id: number;
  topic: string;
  payload: string;
  tipo: TipoMensaje;
  /** epoch ms en que se encoló, para medir el retraso. */
  creadoEn: number;
  intentos: number;
}

let db: SQLite.SQLiteDatabase | null = null;

export async function abrirOutbox(): Promise<void> {
  if (db) return;
  db = await SQLite.openDatabaseAsync('sitciit-outbox.db');
  await db.execAsync(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS outbox (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      topic     TEXT    NOT NULL,
      payload   TEXT    NOT NULL,
      tipo      TEXT    NOT NULL,
      creado_en INTEGER NOT NULL,
      intentos  INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS outbox_orden ON outbox (id);
  `);
}

/**
 * Encola un mensaje. El orden de salida es el de llegada (por `id`),
 * que respeta el `seq` del contrato.
 *
 * Cuando la cola se llena se descarta telemetría vieja, nunca eventos:
 * perder una lectura de rutina no cambia nada, perder un impacto sí.
 */
export async function encolar(
  topic: string,
  payload: string,
  tipo: TipoMensaje,
): Promise<void> {
  if (!db) await abrirOutbox();
  const d = db!;

  await d.runAsync(
    'INSERT INTO outbox (topic, payload, tipo, creado_en) VALUES (?, ?, ?, ?)',
    [topic, payload, tipo, Date.now()],
  );

  const fila = await d.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM outbox');
  if ((fila?.n ?? 0) > MAX_FILAS) {
    const sobran = (fila?.n ?? 0) - MAX_FILAS;
    await d.runAsync(
      `DELETE FROM outbox WHERE id IN (
         SELECT id FROM outbox WHERE tipo IN ('telemetry', 'heartbeat')
         ORDER BY id LIMIT ?
       )`,
      [sobran],
    );
  }
}

/** Siguiente tanda a enviar, en orden de encolado. */
export async function siguienteLote(limite = LOTE): Promise<MensajePendiente[]> {
  if (!db) await abrirOutbox();
  const filas = await db!.getAllAsync<{
    id: number;
    topic: string;
    payload: string;
    tipo: TipoMensaje;
    creado_en: number;
    intentos: number;
  }>('SELECT id, topic, payload, tipo, creado_en, intentos FROM outbox ORDER BY id LIMIT ?', [
    limite,
  ]);
  return filas.map((f) => ({
    id: f.id,
    topic: f.topic,
    payload: f.payload,
    tipo: f.tipo,
    creadoEn: f.creado_en,
    intentos: f.intentos,
  }));
}

/** Borra un mensaje: solo tras la confirmación del broker (QoS 1). */
export async function confirmar(id: number): Promise<void> {
  if (!db) return;
  await db.runAsync('DELETE FROM outbox WHERE id = ?', [id]);
}

/** Marca un intento fallido. El mensaje se queda en la cola; el contador
 *  sirve para detectar uno que siempre falla (payload corrupto). */
export async function marcarIntento(id: number): Promise<void> {
  if (!db) return;
  await db.runAsync('UPDATE outbox SET intentos = intentos + 1 WHERE id = ?', [id]);
}

/** Descarta un mensaje que el broker rechaza una y otra vez, para que no
 *  bloquee la cola detrás de él. */
export async function descartar(id: number): Promise<void> {
  if (!db) return;
  await db.runAsync('DELETE FROM outbox WHERE id = ?', [id]);
}

export interface EstadoOutbox {
  total: number;
  /** Antigüedad del mensaje más viejo en ms, o null si está vacía. */
  antiguedadMs: number | null;
}

export async function estado(): Promise<EstadoOutbox> {
  if (!db) await abrirOutbox();
  const fila = await db!.getFirstAsync<{ n: number; mas_viejo: number | null }>(
    'SELECT COUNT(*) AS n, MIN(creado_en) AS mas_viejo FROM outbox',
  );
  const total = fila?.n ?? 0;
  return {
    total,
    antiguedadMs: fila?.mas_viejo ? Date.now() - fila.mas_viejo : null,
  };
}

/** Vacía la cola. Solo para pruebas y para el botón de la app. */
export async function vaciar(): Promise<void> {
  if (!db) await abrirOutbox();
  await db!.runAsync('DELETE FROM outbox');
}
