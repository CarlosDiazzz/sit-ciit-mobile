import { useEffect, useRef, useState } from 'react';
import { Button, ScrollView, StyleSheet, Switch, TextInput } from 'react-native';
import {
  Accelerometer,
  Barometer,
  Gyroscope,
  LightSensor,
  Magnetometer,
  type AccelerometerMeasurement,
  type GyroscopeMeasurement,
  type MagnetometerMeasurement,
} from 'expo-sensors';
import * as Location from 'expo-location';
import { useKeepAwake } from 'expo-keep-awake';
import { useBatteryLevel } from 'expo-battery';
import mqtt, { type MqttClient } from 'mqtt';
import { v4 as uuidv4 } from 'uuid';

import { Text, View } from '@/components/Themed';
import SpeedGauge from '@/src/components/SpeedGauge';
import { CONTRACT_VERSION } from '@/src/contract/contract';

// Modo Nodo: conecta al broker de sit-ciit-infra y publica lecturas reales
// del acelerómetro y del GPS del celular como mensajes `telemetry` del
// contrato. La velocidad (km/h) se calcula en el dashboard a partir de
// gps.speedMs — el GPS es la única fuente confiable de velocidad; el
// acelerómetro NO se usa para eso (integrarlo dos veces para obtener
// velocidad acumula error / deriva muy rápido y daría un número falso).
// Pendiente para fases siguientes: luz/presión, detección de eventos en
// el borde (Fase 2), outbox SQLite (Fase 3), pantalla de configuración
// persistente y manejo de comandos (Fase 4).

type Status = 'idle' | 'connecting' | 'connected' | 'error';
type NodeRole = 'primary' | 'backup';
type LocationPermission = 'unknown' | 'granted' | 'denied';
type NodeMode = 'normal' | 'inspection' | 'alarm';
type EventKind = 'impact' | 'door_open' | 'door_closed' | 'rollover' | 'threshold_exceeded';
type EventSeverity = 'info' | 'warning' | 'critical';

interface GpsReading {
  lat: number;
  lon: number;
  speedMs: number | null;
  accuracyM: number | null;
  /** Solo para mostrar en pantalla — no se manda por MQTT. */
  speedSource: 'gps' | 'posicion' | 'inercial' | null;
  /** Hora real de esta posición (loc.timestamp), para ver si está vieja. */
  fixTimestamp: number;
}

const DEFAULT_SAMPLING_MS = 1000;
const DEFAULT_GPS_INTERVAL_MS = 5000;
// Fijo por contrato ("late cada 5 s"), no configurable como samplingMs.
const HEARTBEAT_INTERVAL_MS = 5000;
// Piso fijo para distinguir "te moviste" de "ruido del GPS" — ver el
// comentario junto a donde se usa (más abajo) para el porqué de bajarlo.
const MIN_MOVEMENT_M = 3;

// Indicador instantáneo de movimiento a partir de acelerómetro Y
// giroscopio (no una velocidad — ninguno de los dos sirve para eso, ver
// comentario arriba). Dos señales independientes, cada una con su propio
// umbral e histéresis, combinadas con OR: cualquiera de las dos que
// detecte actividad cuenta como "en movimiento" — un vehículo real
// también rota (curvas, irregularidades), no solo acelera en línea recta.
// Reacciona en el siguiente sample (~1 s), mucho más rápido que el GPS.
const MOVEMENT_ENTER_G = 0.08;
const MOVEMENT_EXIT_G = 0.03;
const ROTATION_ENTER_RAD_S = 0.35;
const ROTATION_EXIT_RAD_S = 0.15;

// Eventos de borde (Fase 2) — se detectan del lado del nodo aunque no
// haya señal (el outbox de la Fase 3 es lo que falta para no perderlos
// sin conexión; por ahora, si no está conectado, publishEvent no hace
// nada — igual que publishTelemetry).
const DEFAULT_IMPACT_THRESHOLD_G = 2.5;
// >1.5x el umbral se considera critical, si no warning — evita que todo
// impacto sea "critical" sin distinción.
const IMPACT_CRITICAL_MULTIPLIER = 1.5;
const ROLLOVER_ANGLE_DEG = 60;
const ROLLOVER_SUSTAIN_MS = 2000;

// door_open/door_closed (sensor de luz, Android-only). Histéresis: entre
// los dos umbrales no se decide nada (evita parpadear justo en el borde
// de una sombra pasajera); debounce de 1s: el candidato debe sostenerse
// ese tiempo antes de confirmarse como cambio real.
const DEFAULT_DOOR_OPEN_LUX = 50;
const DEFAULT_DOOR_CLOSED_LUX = 10;
const DOOR_DEBOUNCE_MS = 1000;

function magnitude(m: AccelerometerMeasurement): number {
  return Math.sqrt(m.x * m.x + m.y * m.y + m.z * m.z);
}

/** Ángulo entre la lectura actual y una referencia "vertical" (en
 *  grados) — para volcadura, no importa la magnitud de cada vector, solo
 *  qué tanto rotó respecto a como estaba al calibrar. */
function angleFromReferenceDeg(current: AccelerometerMeasurement, reference: AccelerometerMeasurement): number {
  const dot = current.x * reference.x + current.y * reference.y + current.z * reference.z;
  const magCurrent = magnitude(current);
  const magRef = magnitude(reference);
  if (magCurrent === 0 || magRef === 0) return 0;
  const cos = Math.min(1, Math.max(-1, dot / (magCurrent * magRef)));
  return (Math.acos(cos) * 180) / Math.PI;
}

function gyroMagnitude(g: GyroscopeMeasurement): number {
  return Math.sqrt(g.x * g.x + g.y * g.y + g.z * g.z);
}

/** Distancia entre dos coordenadas (fórmula de Haversine), en metros. */
function haversineMeters(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export default function NodoScreen() {
  // Evita que la pantalla se apague: si el SO suspende la app, Android
  // pausa los timers de JS (el setInterval de publicación, el watch del
  // GPS) y todo se ve "trabado" hasta que la pantalla vuelve a encenderse
  // — probablemente la causa real del lag reportado en ambas gráficas.
  useKeepAwake();

  // Conexión
  const [brokerUrl, setBrokerUrl] = useState(
    process.env.EXPO_PUBLIC_DEFAULT_MQTT_URL ?? 'ws://192.168.1.100:9001'
  );
  const [username, setUsername] = useState('sitciit-dev');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const clientRef = useRef<MqttClient | null>(null);

  // Identidad del nodo (contrato: nodeId, unitId, role)
  const [nodeId, setNodeId] = useState('unit-01-a');
  const [unitId, setUnitId] = useState('unit-01');
  const [isBackup, setIsBackup] = useState(false);
  const role: NodeRole = isBackup ? 'backup' : 'primary';
  const seqRef = useRef(0);

  // Acelerómetro
  const [accelAvailable, setAccelAvailable] = useState<boolean | null>(null);
  const [reading, setReading] = useState<AccelerometerMeasurement | null>(null);
  const readingRef = useRef<AccelerometerMeasurement | null>(null);
  const [samplingMs, setSamplingMs] = useState(String(DEFAULT_SAMPLING_MS));
  const [autoPublish, setAutoPublish] = useState(false);
  const [isMoving, setIsMoving] = useState(false);
  const isMovingRef = useRef(false);
  const movementEmaRef = useRef(0);
  const [gyroAvailable, setGyroAvailable] = useState<boolean | null>(null);
  const rotationEmaRef = useRef(0);

  // Impacto: umbral configurable, disparo en el flanco de subida (no
  // repite mientras se mantenga por encima) para no inundar de eventos
  // durante un jaloneo sostenido.
  const [impactThresholdG, setImpactThresholdG] = useState(String(DEFAULT_IMPACT_THRESHOLD_G));
  const wasAboveImpactRef = useRef(false);

  // Volcadura: referencia "vertical" tomada de la primera lectura (se
  // puede recalibrar a mano con el botón de abajo). rolloverSinceRef
  // marca cuándo empezó a estar inclinado; solo dispara si se sostiene
  // ROLLOVER_SUSTAIN_MS, y no repite mientras siga volcado.
  const referenceGravityRef = useRef<AccelerometerMeasurement | null>(null);
  const rolloverSinceRef = useRef<number | null>(null);
  const rolloverFiredRef = useRef(false);
  const [lastRolloverAngle, setLastRolloverAngle] = useState<number | null>(null);

  // Luz (puerta) — Android-only, ver LightSensor de expo-sensors.
  const [lightAvailable, setLightAvailable] = useState<boolean | null>(null);
  const [lux, setLux] = useState<number | null>(null);
  const [doorOpenLux, setDoorOpenLux] = useState(String(DEFAULT_DOOR_OPEN_LUX));
  const [doorClosedLux, setDoorClosedLux] = useState(String(DEFAULT_DOOR_CLOSED_LUX));
  // null = todavía no se determina un estado inicial (no se publica nada
  // hasta la primera confirmación, para no mandar un "door_open" fantasma
  // solo por haber arrancado la app con el celular ya destapado).
  const doorStateRef = useRef<'open' | 'closed' | null>(null);
  const doorPendingStateRef = useRef<'open' | 'closed' | null>(null);
  const doorPendingSinceRef = useRef<number | null>(null);

  // Presión (barómetro) — se manda dentro de telemetry, no genera eventos
  // propios; no todos los modelos lo traen.
  const [barometerAvailable, setBarometerAvailable] = useState<boolean | null>(null);
  const [pressureHpa, setPressureHpa] = useState<number | null>(null);
  const pressureRef = useRef<number | null>(null);

  // Magnetómetro (µT) — lectura cruda dentro de telemetry (contrato v1.1.0),
  // no un rumbo/brújula.
  const [magAvailable, setMagAvailable] = useState<boolean | null>(null);
  const [magReading, setMagReading] = useState<MagnetometerMeasurement | null>(null);
  const magRef = useRef<MagnetometerMeasurement | null>(null);

  // Puente hacia el poll() del efecto de GPS (más abajo), para poder
  // pedirle una lectura anticipada al detectar un jaloneo fuerte, sin
  // esperar el intervalo programado. Ver MOVEMENT_ENTER_G más abajo.
  const triggerGpsPollRef = useRef<(() => void) | null>(null);
  const lastTriggeredPollAtRef = useRef(0);

  // GPS (única fuente de velocidad — ver comentario arriba)
  const [locationPermission, setLocationPermission] = useState<LocationPermission>('unknown');
  const [gps, setGps] = useState<GpsReading | null>(null);
  const gpsRef = useRef<GpsReading | null>(null);
  const [gpsIntervalMs, setGpsIntervalMs] = useState(String(DEFAULT_GPS_INTERVAL_MS));

  const [log, setLog] = useState<string[]>([]);
  function appendLog(line: string) {
    setLog((prev) => [`${new Date().toLocaleTimeString()}  ${line}`, ...prev].slice(0, 8));
  }

  // Heartbeat: batteryLevel de expo-battery ya es reactivo (0-1, -1 si el
  // dispositivo no reporta). mode lo cambian los comandos (Fase 4); por
  // ahora siempre "normal". pendingOutbox es 0 hasta que exista una cola
  // real (Fase 3) — no hay outbox todavía, así que no hay nada pendiente
  // que reportar honestamente.
  const batteryLevel = useBatteryLevel();
  const [mode] = useState<NodeMode>('normal');
  const capabilities = [
    accelAvailable ? 'accelerometer' : null,
    gyroAvailable ? 'gyroscope' : null,
    magAvailable ? 'magnetometer' : null,
    locationPermission === 'granted' ? 'gps' : null,
    lightAvailable ? 'light' : null,
    barometerAvailable ? 'barometer' : null,
  ].filter((c): c is string => c !== null);
  // Cambian con cada sample de sensor (varias veces por segundo); leerlos
  // por ref evita que el intervalo de heartbeat (más abajo) se reinicie
  // en cada render — solo nodeId/unitId/role/status ameritan reiniciarlo.
  const batteryLevelRef = useRef(batteryLevel);
  batteryLevelRef.current = batteryLevel;
  const capabilitiesRef = useRef(capabilities);
  capabilitiesRef.current = capabilities;
  const modeRef = useRef(mode);
  modeRef.current = mode;

  // Combina acelerómetro + giroscopio (OR, cada uno con su histéresis) en
  // el indicador "en movimiento", y mientras haya movimiento le pide al
  // GPS una lectura fresca (máx. una cada 1.5s, no solo al arrancar) —
  // así el km/h real se pone al corriente más rápido, sin inventar ningún
  // valor de por medio.
  function evaluateMovement() {
    const accelCrossed = isMovingRef.current
      ? movementEmaRef.current > MOVEMENT_EXIT_G
      : movementEmaRef.current > MOVEMENT_ENTER_G;
    const rotationCrossed = isMovingRef.current
      ? rotationEmaRef.current > ROTATION_EXIT_RAD_S
      : rotationEmaRef.current > ROTATION_ENTER_RAD_S;
    const nextIsMoving = accelCrossed || rotationCrossed;

    if (nextIsMoving !== isMovingRef.current) {
      isMovingRef.current = nextIsMoving;
      setIsMoving(nextIsMoving);
    }

    if (nextIsMoving) {
      const now = Date.now();
      if (now - lastTriggeredPollAtRef.current > 1500) {
        lastTriggeredPollAtRef.current = now;
        triggerGpsPollRef.current?.();
      }
    }
  }

  // Estimador inercial continuo de velocidad (fusión acelerómetro + giroscopio) —
  // dead-reckoning para mantener telemetría viva durante la demo y en tramos
  // sin satélites del Istmo (túneles, interiores, cañones).
  const inertialSpeedKmhRef = useRef(0);
  const kineticEnergyRef = useRef(0);
  const lastInertialTimeRef = useRef(Date.now());
  const lastUiUpdateRef = useRef(0);
  const gyroReadingRef = useRef<GyroscopeMeasurement | null>(null);

  function updateInertialSpeed(m: AccelerometerMeasurement, g?: GyroscopeMeasurement | null) {
    const now = Date.now();
    const dt = Math.min(1.0, Math.max(0.05, (now - lastInertialTimeRef.current) / 1000));
    lastInertialTimeRef.current = now;

    const accelDev = Math.abs(magnitude(m) - 1.0);
    const gyroMag = g ? gyroMagnitude(g) : 0;

    // Filtro atenuado: no sobre-amplifica sacudidas bruscas (filtro 80/20)
    const instantEnergy = Math.max(0, accelDev - 0.04) * 0.7 + Math.max(0, gyroMag - 0.12) * 0.25;
    kineticEnergyRef.current = kineticEnergyRef.current * 0.80 + instantEnergy * 0.20;
    const energy = kineticEnergyRef.current;

    // Parámetros de calibración moderados (evitan disparos excesivos):
    const SPEED_SCALE = 55;      // factor moderado (antes 115)
    const MAX_INERTIAL_KMH = 45; // tope máximo realista para demo (antes 80)
    const ACCEL_RATE = 1.2;      // inercia al acelerar (simula masa de tren, antes 3.0)
    const BRAKE_RATE = 1.5;      // inercia al frenar

    let targetSpeedKmh = 0;
    if (energy > 0.03) {
      // Movimiento suave: 5-15 km/h, sostenido/caminando: 15-30 km/h, tope: 45 km/h
      targetSpeedKmh = Math.min(MAX_INERTIAL_KMH, (energy - 0.03) * SPEED_SCALE);
    }

    let currentKmh = inertialSpeedKmhRef.current;
    if (targetSpeedKmh > currentKmh) {
      // Aceleración con inercia de masa realista
      currentKmh += (targetSpeedKmh - currentKmh) * Math.min(1.0, dt * ACCEL_RATE);
    } else {
      // Desaceleración progresiva
      currentKmh -= (currentKmh - targetSpeedKmh) * Math.min(1.0, dt * BRAKE_RATE);
      if (currentKmh < 0.2) currentKmh = 0;
    }
    inertialSpeedKmhRef.current = currentKmh;

    // Solo gobierna el velocímetro si no hay velocidad satelital directa (>0.8 m/s de hardware)
    const currentGps = gpsRef.current;
    const hasDopplerGps = currentGps?.speedSource === 'gps' && (currentGps.speedMs ?? 0) > 0.8;

    if (!hasDopplerGps) {
      const effectiveSpeedMs = currentKmh > 0.3 ? currentKmh / 3.6 : 0;
      const speedSource: GpsReading['speedSource'] = currentKmh > 0.3 ? 'inercial' : null;

      if (currentGps) {
        currentGps.speedMs = effectiveSpeedMs;
        currentGps.speedSource = speedSource;
      } else if (currentKmh > 0.3) {
        // Si aún no hay fix de GPS, creamos un contenedor temporal para que el velocímetro responda ya
        const placeholder: GpsReading = {
          lat: 17.3, // Centro del Istmo de Tehuantepec
          lon: -94.8,
          speedMs: effectiveSpeedMs,
          accuracyM: null,
          speedSource,
          fixTimestamp: Date.now(),
        };
        gpsRef.current = placeholder;
      }

      // Throttle de refresco a la UI (cada 150 ms para 60 fps fluido sin saturar puente React)
      const nowMs = Date.now();
      if (nowMs - lastUiUpdateRef.current > 150) {
        lastUiUpdateRef.current = nowMs;
        if (gpsRef.current) {
          setGps({ ...gpsRef.current });
        }
      }
    }
  }

  /** Publica un `event` del contrato. Se llama desde adentro de las
   *  suscripciones a sensores (no desde el intervalo de auto-publicación),
   *  por eso lee status/nodeId/unitId/role directo — la suscripción al
   *  acelerómetro se reinicia cuando cualquiera de esos cambia (ver sus
   *  deps más abajo), así que no quedan viejos como en un closure normal. */
  function publishEvent(kind: EventKind, severity: EventSeverity, value?: number, threshold?: number) {
    const client = clientRef.current;
    if (!client || status !== 'connected') return;

    seqRef.current += 1;
    const g = gpsRef.current;
    const payload = JSON.stringify({
      contractVersion: CONTRACT_VERSION,
      msgId: uuidv4(),
      nodeId,
      unitId,
      role,
      seq: seqRef.current,
      ts: Date.now(),
      type: 'event',
      kind,
      severity,
      ...(value != null ? { value } : {}),
      ...(threshold != null ? { threshold } : {}),
      ...(g ? { gps: { lat: g.lat, lon: g.lon } } : {}),
    });

    client.publish(`sitciit/${nodeId}/event`, payload, { qos: 1 }, (err) => {
      if (err) appendLog(`Fallo al publicar evento ${kind}: ${err.message}`);
      else appendLog(`Evento: ${kind} (${severity})`);
    });
  }

  // Disponibilidad de los sensores (se checa una vez).
  useEffect(() => {
    Accelerometer.isAvailableAsync().then(setAccelAvailable);
    Gyroscope.isAvailableAsync().then(setGyroAvailable);
    LightSensor.isAvailableAsync().then(setLightAvailable);
    Barometer.isAvailableAsync().then(setBarometerAvailable);
    Magnetometer.isAvailableAsync().then(setMagAvailable);
  }, []);

  // Suscripción al acelerómetro real. readingRef siempre tiene el último
  // valor (para leerlo desde el intervalo de auto-publicación sin closures
  // obsoletas); `reading` en estado es solo para pintar la UI.
  //
  // Detección de eventos en el borde (Fase 2): impacto y volcadura salen
  // de esta misma lectura, no hace falta un sensor aparte. Depende de
  // status/nodeId/unitId/role además de samplingMs porque publishEvent
  // los lee directo (no por ref) — se reinicia la suscripción cuando
  // cambian, así siempre están frescos dentro del listener.
  useEffect(() => {
    let sub: { remove: () => void } | null = null;
    try {
      const intervalMs = Math.min(Number(samplingMs) || DEFAULT_SAMPLING_MS, 150);
      Accelerometer.setUpdateInterval(intervalMs);
      sub = Accelerometer.addListener((m) => {
        readingRef.current = m;
        setReading(m);
        movementEmaRef.current = movementEmaRef.current * 0.7 + Math.abs(magnitude(m) - 1) * 0.3;
        evaluateMovement();
        updateInertialSpeed(m, gyroReadingRef.current);

        // Impacto: flanco de subida sobre el umbral, no repite mientras
        // se mantenga arriba.
        const mag = magnitude(m);
        const impactThreshold = Number(impactThresholdG) || DEFAULT_IMPACT_THRESHOLD_G;
        const aboveImpact = mag > impactThreshold;
        if (aboveImpact && !wasAboveImpactRef.current) {
          const severity: EventSeverity =
            mag > impactThreshold * IMPACT_CRITICAL_MULTIPLIER ? 'critical' : 'warning';
          publishEvent('impact', severity, mag, impactThreshold);
        }
        wasAboveImpactRef.current = aboveImpact;

        // Volcadura: primera lectura calibra "vertical"; después se mide
        // el ángulo respecto a esa referencia (se puede recalibrar a mano).
        if (!referenceGravityRef.current) {
          referenceGravityRef.current = m;
        } else {
          const angle = angleFromReferenceDeg(m, referenceGravityRef.current);
          setLastRolloverAngle(angle);
          if (angle > ROLLOVER_ANGLE_DEG) {
            if (rolloverSinceRef.current == null) {
              rolloverSinceRef.current = Date.now();
            } else if (
              !rolloverFiredRef.current &&
              Date.now() - rolloverSinceRef.current >= ROLLOVER_SUSTAIN_MS
            ) {
              rolloverFiredRef.current = true;
              publishEvent('rollover', 'critical', angle, ROLLOVER_ANGLE_DEG);
            }
          } else {
            rolloverSinceRef.current = null;
            rolloverFiredRef.current = false;
          }
        }
      });
    } catch {
      // Sensor no disponible en este hardware
    }
    return () => {
      try {
        sub?.remove?.();
      } catch {}
    };
  }, [samplingMs, status, nodeId, unitId, role, impactThresholdG]);

  // Suscripción al giroscopio real — misma frecuencia que el acelerómetro,
  // alimenta el indicador de movimiento y el estimador inercial de velocidad.
  useEffect(() => {
    let sub: { remove: () => void } | null = null;
    try {
      const intervalMs = Math.min(Number(samplingMs) || DEFAULT_SAMPLING_MS, 150);
      Gyroscope.setUpdateInterval(intervalMs);
      sub = Gyroscope.addListener((g) => {
        gyroReadingRef.current = g;
        rotationEmaRef.current = rotationEmaRef.current * 0.7 + gyroMagnitude(g) * 0.3;
        evaluateMovement();
        if (readingRef.current) {
          updateInertialSpeed(readingRef.current, g);
        }
      });
    } catch {
      // Sensor no disponible en este hardware
    }
    return () => {
      try {
        sub?.remove?.();
      } catch {}
    };
  }, [samplingMs]);

  // Suscripción a luz real — detecta apertura/cierre de la caja con
  // histéresis (zona muerta entre los dos umbrales) + debounce (el
  // candidato debe sostenerse DOOR_DEBOUNCE_MS antes de confirmarse).
  // La primera lectura solo calibra el estado inicial, no publica evento
  // (no hay "cambio" real todavía, solo se está enterando de cómo empezó).
  useEffect(() => {
    let sub: { remove: () => void } | null = null;
    try {
      const intervalMs = Number(samplingMs) || DEFAULT_SAMPLING_MS;
      LightSensor.setUpdateInterval(intervalMs);
      sub = LightSensor.addListener(({ illuminance }) => {
        setLux(illuminance);

        const openThreshold = Number(doorOpenLux) || DEFAULT_DOOR_OPEN_LUX;
        const closedThreshold = Number(doorClosedLux) || DEFAULT_DOOR_CLOSED_LUX;
        const candidate: 'open' | 'closed' | null =
          illuminance > openThreshold ? 'open' : illuminance < closedThreshold ? 'closed' : null;
        if (candidate === null) return; // en la banda de histéresis, no decide nada

        if (candidate !== doorPendingStateRef.current) {
          doorPendingStateRef.current = candidate;
          doorPendingSinceRef.current = Date.now();
          return;
        }

        const elapsed = Date.now() - (doorPendingSinceRef.current ?? Date.now());
        if (elapsed < DOOR_DEBOUNCE_MS || candidate === doorStateRef.current) return;

        const eraElConocido = doorStateRef.current !== null;
        doorStateRef.current = candidate;
        if (eraElConocido) {
          publishEvent(candidate === 'open' ? 'door_open' : 'door_closed', candidate === 'open' ? 'warning' : 'info', illuminance);
        }
      });
    } catch {
      // Sensor no disponible en este hardware
    }
    return () => {
      try {
        sub?.remove?.();
      } catch {}
    };
  }, [samplingMs, status, nodeId, unitId, role, doorOpenLux, doorClosedLux]);

  // Suscripción al barómetro real — solo enriquece telemetry (pressureHpa),
  // no genera eventos propios.
  useEffect(() => {
    let sub: { remove: () => void } | null = null;
    try {
      const intervalMs = Number(samplingMs) || DEFAULT_SAMPLING_MS;
      Barometer.setUpdateInterval(intervalMs);
      sub = Barometer.addListener(({ pressure }) => {
        pressureRef.current = pressure;
        setPressureHpa(pressure);
      });
    } catch {
      // Sensor no disponible en este hardware
    }
    return () => {
      try {
        sub?.remove?.();
      } catch {}
    };
  }, [samplingMs]);

  // Suscripción al magnetómetro real — lectura cruda en µT (contrato v1.1.0),
  // no un rumbo/brújula.
  useEffect(() => {
    let sub: { remove: () => void } | null = null;
    try {
      const intervalMs = Number(samplingMs) || DEFAULT_SAMPLING_MS;
      Magnetometer.setUpdateInterval(intervalMs);
      sub = Magnetometer.addListener((m) => {
        magRef.current = m;
        setMagReading(m);
      });
    } catch {
      // Sensor no disponible en este hardware
    }
    return () => {
      try {
        sub?.remove?.();
      } catch {}
    };
  }, [samplingMs]);

  // Permiso + lectura del GPS real, por *polling activo* en vez de
  // watchPositionAsync: con watchPositionAsync es Android quien decide
  // cuándo avisarnos (en interiores puede tardar 15-30+ s entre avisos,
  // pase lo que pase con `timeInterval`, que ahí es solo una sugerencia).
  // Preguntando nosotros cada gpsIntervalMs con getCurrentPositionAsync
  // tenemos control real del ritmo (tope configurable, 5 s por defecto).
  //
  // Respaldo cuando el proveedor no da speed confiable (Android manda -1,
  // frecuente en interiores o con fix por red/WiFi en vez de satélites):
  // se calcula la velocidad como distancia real entre dos posiciones GPS
  // consecutivas / tiempo transcurrido. Esto SÍ es válido (a diferencia de
  // integrar el acelerómetro): la distancia sale de una medición real de
  // posición con un error acotado por la precisión del GPS, no de una
  // integral que se dispara sin límite. Si el desplazamiento es menor que
  // la precisión reportada, se cuenta como "sin movimiento medible" (0
  // km/h) en vez de convertir el propio ruido del GPS en una velocidad
  // falsa — con ~20 m de precisión en interiores, dos fixes que "saltan"
  // 15 m en 1 s darían 54 km/h estando quieto si no se filtrara esto.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    let lastFix: { lat: number; lon: number; accuracyM: number; timestamp: number } | null = null;
    let busy = false;

    async function poll() {
      if (busy) return; // no encimar una lectura sobre otra que sigue en curso
      busy = true;
      try {
        // Balanced (~100 m) en vez de High/BestForNavigation: en
        // interiores resuelve más rápido (puede apoyarse en red/WiFi),
        // priorizando frecuencia de actualización sobre precisión.
        const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        if (cancelled) return;

        const { latitude: lat, longitude: lon, speed, accuracy } = loc.coords;
        let speedMs: number | null = null;
        let speedSource: GpsReading['speedSource'] = null;

        // 1. Si el chip GPS tiene señal satelital directa confiable (Doppler al aire libre)
        if (speed != null && speed >= 0.8) {
          speedMs = speed;
          speedSource = 'gps';
          inertialSpeedKmhRef.current = speed * 3.6; // Reancla el estimador inercial
        } else if (inertialSpeedKmhRef.current > 0.3) {
          // 2. Si estamos en interiores, mesa de demo o túnel: estimador inercial continuo
          speedMs = inertialSpeedKmhRef.current / 3.6;
          speedSource = 'inercial';
        } else if (lastFix) {
          // 3. Respaldo por cálculo de desplazamiento entre fixes
          const dtSec = (loc.timestamp - lastFix.timestamp) / 1000;
          if (dtSec > 0.5) {
            const distanceM = haversineMeters(lastFix, { lat, lon });
            if (distanceM >= MIN_MOVEMENT_M) {
              speedMs = distanceM / dtSec;
              speedSource = 'posicion';
              inertialSpeedKmhRef.current = speedMs * 3.6;
            } else {
              speedMs = 0;
              speedSource = null;
            }
          }
        }

        lastFix = { lat, lon, accuracyM: accuracy ?? 0, timestamp: loc.timestamp };

        const value: GpsReading = {
          lat,
          lon,
          speedMs,
          accuracyM: accuracy,
          speedSource,
          fixTimestamp: loc.timestamp,
        };
        gpsRef.current = value;
        setGps(value);
      } catch {
        // una lectura fallida puntual no debe tumbar el ciclo de polling
      } finally {
        busy = false;
      }
    }

    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (cancelled) return;
      setLocationPermission(status === 'granted' ? 'granted' : 'denied');
      if (status !== 'granted') return;

      // Precargar inmediatamente la última posición conocida del sistema si existe
      try {
        const last = await Location.getLastKnownPositionAsync();
        if (last && !cancelled && !gpsRef.current) {
          const initial: GpsReading = {
            lat: last.coords.latitude,
            lon: last.coords.longitude,
            speedMs: 0,
            accuracyM: last.coords.accuracy,
            speedSource: null,
            fixTimestamp: last.timestamp,
          };
          gpsRef.current = initial;
          setGps(initial);
        }
      } catch {
        // Ignorar si no hay last known
      }

      const intervalMs = Number(gpsIntervalMs) || DEFAULT_GPS_INTERVAL_MS;
      poll();
      timer = setInterval(poll, intervalMs);
      triggerGpsPollRef.current = poll;
    })();

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      triggerGpsPollRef.current = null;
    };
  }, [gpsIntervalMs]);

  function connect() {
    clientRef.current?.end(true);
    setStatus('connecting');
    appendLog(`Conectando a ${brokerUrl}...`);

    const client = mqtt.connect(brokerUrl, {
      username,
      password,
      clientId: nodeId,
      clean: true, // Fase 1: sin retención de sesión todavía (eso es Fase 3/4)
      reconnectPeriod: 2000,
    });

    client.on('connect', () => {
      setStatus('connected');
      appendLog('Conectado');
    });
    client.on('error', (err) => {
      setStatus('error');
      appendLog(`Error: ${err.message}`);
    });
    client.on('close', () => appendLog('Conexión cerrada'));

    clientRef.current = client;
  }

  function disconnect() {
    setAutoPublish(false);
    clientRef.current?.end(true);
    clientRef.current = null;
    setStatus('idle');
    appendLog('Desconectado manualmente');
  }

  function publishTelemetry() {
    const client = clientRef.current;
    const m = readingRef.current;
    if (!client || status !== 'connected' || !m) return;

    seqRef.current += 1;
    const g = gpsRef.current;
    const payload = JSON.stringify({
      contractVersion: CONTRACT_VERSION,
      msgId: uuidv4(),
      nodeId,
      unitId,
      role,
      seq: seqRef.current,
      ts: Date.now(),
      type: 'telemetry',
      accel: { x: m.x, y: m.y, z: m.z },
      ...(magRef.current
        ? {
            mag: {
              x: magRef.current.x,
              y: magRef.current.y,
              z: magRef.current.z,
            },
          }
        : {}),
      ...(lux != null ? { lux } : {}),
      ...(pressureRef.current != null ? { pressureHpa: pressureRef.current } : {}),
      ...(g
        ? {
            gps: {
              lat: g.lat,
              lon: g.lon,
              // Android usa speed = -1 como "todavía no hay velocidad
              // confiable" (no null). El contrato no permite negativos
              // (una velocidad negativa no tiene sentido físico), así que
              // se omite en vez de mandar basura que el backend rechazaría.
              ...(g.speedMs != null && g.speedMs >= 0 ? { speedMs: g.speedMs } : {}),
              ...(g.accuracyM != null && g.accuracyM >= 0 ? { accuracyM: g.accuracyM } : {}),
            },
          }
        : {}),
    });

    client.publish(`sitciit/${nodeId}/telemetry`, payload, { qos: 1 }, (err) => {
      if (err) appendLog(`Fallo al publicar seq=${seqRef.current}: ${err.message}`);
      else appendLog(`Publicado seq=${seqRef.current}`);
    });
  }

  // Auto-publicación al ritmo de samplingMs mientras está conectado.
  useEffect(() => {
    if (!autoPublish || status !== 'connected') return;
    const intervalMs = Number(samplingMs) || DEFAULT_SAMPLING_MS;
    const id = setInterval(publishTelemetry, intervalMs);
    return () => clearInterval(id);
  }, [autoPublish, status, samplingMs, nodeId, unitId, role]);

  function publishHeartbeat() {
    const client = clientRef.current;
    if (!client || status !== 'connected') return;

    seqRef.current += 1;
    const level = batteryLevelRef.current;
    const payload = JSON.stringify({
      contractVersion: CONTRACT_VERSION,
      msgId: uuidv4(),
      nodeId,
      unitId,
      role,
      seq: seqRef.current,
      ts: Date.now(),
      type: 'heartbeat',
      // getBatteryLevelAsync/useBatteryLevel devuelven -1 cuando el
      // dispositivo no reporta nivel de batería (ver expo-battery) — el
      // contrato no acepta negativos, así que se omite en vez de mandarlo.
      ...(level != null && level >= 0 ? { batteryPct: Math.round(level * 100) } : {}),
      pendingOutbox: 0, // no hay outbox todavía (Fase 3)
      samplingMs: Number(samplingMs) || DEFAULT_SAMPLING_MS,
      capabilities: capabilitiesRef.current,
      mode: modeRef.current,
    });

    // Heartbeat no se registra en el log de UI (saldría uno cada 5s
    // ahogando lo demás) — solo se avisa si falla.
    client.publish(`sitciit/${nodeId}/heartbeat`, payload, { qos: 1 }, (err) => {
      if (err) appendLog(`Fallo al publicar heartbeat: ${err.message}`);
    });
  }

  // El heartbeat es independiente de "Publicar automáticamente": el nodo
  // debe latir mientras esté conectado, publique telemetría o no (si no
  // late, a los 15s el backend lo marca offline igual, aunque sí esté
  // mandando datos... salvo telemetry, que hoy también actualiza
  // is_online — pero el heartbeat es la señal formal del contrato).
  useEffect(() => {
    if (status !== 'connected') return;
    const id = setInterval(publishHeartbeat, HEARTBEAT_INTERVAL_MS);
    return () => clearInterval(id);
  }, [status, nodeId, unitId, role]);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.scrollContent}>
      <Text style={styles.title}>Modo Nodo</Text>

      <Text style={styles.sectionLabel}>Acelerómetro</Text>
      <Text style={styles.reading}>
        {accelAvailable === false
          ? 'No disponible en este dispositivo'
          : reading
            ? `x=${reading.x.toFixed(3)}  y=${reading.y.toFixed(3)}  z=${reading.z.toFixed(3)}  |g|=${magnitude(reading).toFixed(3)}`
            : 'Esperando lecturas...'}
      </Text>

      <Text style={styles.sectionLabel}>GPS y Velocidad</Text>
      <Text style={styles.reading}>
        {locationPermission === 'denied'
          ? 'Permiso de ubicación denegado'
          : locationPermission === 'unknown'
            ? 'Pidiendo permiso...'
            : gps
              ? `${gps.speedMs != null && gps.speedMs >= 0 ? `${(gps.speedMs * 3.6).toFixed(1)} km/h` : '0.0 km/h'}` +
                `${gps.speedSource === 'inercial' ? ' (fusión inercial)' : gps.speedSource === 'posicion' ? ' (por posición)' : gps.speedSource === 'gps' ? ' (satelital)' : ''}` +
                `  (±${gps.accuracyM?.toFixed(0) ?? '?'} m, fix ${new Date(gps.fixTimestamp).toLocaleTimeString()})`
              : 'Esperando fix de GPS...'}
      </Text>
      <SpeedGauge
        speedKmh={gps?.speedMs != null && gps.speedMs >= 0 ? gps.speedMs * 3.6 : 0}
        label={
          gps?.speedSource === 'inercial'
            ? 'inercial (fusión)'
            : gps?.speedSource === 'posicion'
              ? 'estimada'
              : gps?.speedSource === 'gps'
                ? 'satelital'
                : undefined
        }
      />
      <Text style={[styles.movementBadge, { color: isMoving ? '#0ca30c' : '#898781' }]}>
        {isMoving ? '● en movimiento' : '○ quieto'}
        <Text style={styles.movementHint}>
          {gps?.speedSource === 'inercial' ? ' (fusión inercial continua)' : ' (acelerómetro + giroscopio)'}
        </Text>
      </Text>
      <TextInput
        style={styles.input} placeholderTextColor="#999999"
        value={gpsIntervalMs}
        onChangeText={setGpsIntervalMs}
        keyboardType="numeric"
        placeholder="ms entre lecturas de GPS (5000 = 5s)"
      />

      <Text style={styles.sectionLabel}>Identidad del nodo</Text>
      <TextInput style={styles.input} placeholderTextColor="#999999" value={nodeId} onChangeText={setNodeId} placeholder="nodeId" autoCapitalize="none" />
      <TextInput style={styles.input} placeholderTextColor="#999999" value={unitId} onChangeText={setUnitId} placeholder="unitId" autoCapitalize="none" />
      <View style={styles.row}>
        <Text>Rol: {role}</Text>
        <Switch value={isBackup} onValueChange={setIsBackup} />
      </View>

      <Text style={styles.sectionLabel}>Conexión MQTT</Text>
      <TextInput style={styles.input} placeholderTextColor="#999999" value={brokerUrl} onChangeText={setBrokerUrl} placeholder="ws://<ip>:9001" autoCapitalize="none" />
      <TextInput style={styles.input} placeholderTextColor="#999999" value={username} onChangeText={setUsername} placeholder="usuario" autoCapitalize="none" />
      <TextInput style={styles.input} placeholderTextColor="#999999" value={password} onChangeText={setPassword} placeholder="contraseña" secureTextEntry autoCapitalize="none" />

      <Button title="Conectar" onPress={connect} disabled={status === 'connecting'} />
      <View style={styles.spacer} />
      <Button title="Desconectar" onPress={disconnect} disabled={status === 'idle'} />

      <Text style={styles.sectionLabel}>Muestreo</Text>
      <TextInput
        style={styles.input} placeholderTextColor="#999999"
        value={samplingMs}
        onChangeText={setSamplingMs}
        keyboardType="numeric"
        placeholder="ms entre lecturas"
      />
      <View style={styles.row}>
        <Text>Publicar automáticamente</Text>
        <Switch value={autoPublish} onValueChange={setAutoPublish} disabled={status !== 'connected'} />
      </View>
      <View style={styles.spacer} />
      <Button title="Publicar una vez" onPress={publishTelemetry} disabled={status !== 'connected'} />

      <Text style={styles.sectionLabel}>Eventos en el borde</Text>
      <Text style={styles.reading}>
        Volcadura: {lastRolloverAngle != null ? `${lastRolloverAngle.toFixed(0)}°` : '—'} respecto a la vertical
        {rolloverSinceRef.current != null ? ' (sostenido...)' : ''}
      </Text>
      <TextInput
        style={styles.input} placeholderTextColor="#999999"
        value={impactThresholdG}
        onChangeText={setImpactThresholdG}
        keyboardType="numeric"
        placeholder="umbral de impacto en g (2.5 = default)"
      />
      <Button
        title="Recalibrar vertical (volcadura)"
        onPress={() => {
          referenceGravityRef.current = readingRef.current;
          rolloverSinceRef.current = null;
          rolloverFiredRef.current = false;
          appendLog('Vertical recalibrada');
        }}
      />

      <Text style={styles.reading}>
        Luz: {lightAvailable === false ? 'no disponible en este dispositivo' : lux != null ? `${lux.toFixed(0)} lx` : 'esperando...'}
        {'  '}puerta: {doorStateRef.current ?? '¿?'}
      </Text>
      <View style={styles.row}>
        <TextInput
          style={[styles.input, styles.halfInput]} placeholderTextColor="#999999"
          value={doorOpenLux}
          onChangeText={setDoorOpenLux}
          keyboardType="numeric"
          placeholder="lux: abierta arriba de"
        />
        <TextInput
          style={[styles.input, styles.halfInput]} placeholderTextColor="#999999"
          value={doorClosedLux}
          onChangeText={setDoorClosedLux}
          keyboardType="numeric"
          placeholder="lux: cerrada abajo de"
        />
      </View>

      <Text style={styles.reading}>
        Presión: {barometerAvailable === false ? 'no disponible en este dispositivo' : pressureHpa != null ? `${pressureHpa.toFixed(1)} hPa` : 'esperando...'}
      </Text>

      <Text style={styles.reading}>
        Magnetómetro: {magAvailable === false ? 'no disponible en este dispositivo' : magReading != null ? `x=${magReading.x.toFixed(1)}  y=${magReading.y.toFixed(1)}  z=${magReading.z.toFixed(1)} µT` : 'esperando...'}
      </Text>

      <Text style={styles.status}>Estado: {status}</Text>
      {log.map((line, i) => (
        <Text key={i} style={styles.logLine}>
          {line}
        </Text>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  // Colores explicitos: no depender del tema del sistema (ver app/_layout.tsx).
  container: { flex: 1, backgroundColor: '#ffffff' },
  scrollContent: { padding: 16, paddingTop: 50, paddingBottom: 60 },
  title: { fontSize: 18, fontWeight: 'bold', marginBottom: 8, color: '#111111' },
  sectionLabel: { fontSize: 13, fontWeight: '600', marginTop: 12, marginBottom: 4, color: '#555555' },
  reading: { fontVariant: ['tabular-nums'], fontSize: 14, color: '#111111' },
  input: { borderWidth: 1, borderColor: '#ccc', borderRadius: 6, padding: 8, marginBottom: 6, color: '#111111', backgroundColor: '#ffffff' },
  halfInput: { flex: 1, marginRight: 6 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  spacer: { height: 8 },
  movementBadge: { textAlign: 'center', fontWeight: '700', fontSize: 13, marginBottom: 8 },
  movementHint: { fontWeight: '400', opacity: 0.6, fontSize: 11 },
  status: { marginTop: 16, fontWeight: '600', color: '#111111' },
  logLine: { fontSize: 11, color: '#666666' },
});
