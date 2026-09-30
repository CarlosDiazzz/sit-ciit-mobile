import { useEffect, useRef, useState } from 'react';
import { Button, ScrollView, StyleSheet, Switch, TextInput, Vibration } from 'react-native';
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
import * as SecureStore from 'expo-secure-store';
import { useKeepAwake } from 'expo-keep-awake';
import { useBatteryLevel } from 'expo-battery';
import mqtt, { type MqttClient } from 'mqtt';
import { v4 as uuidv4 } from 'uuid';

import { Text, View } from '@/components/Themed';
import SpeedGauge from '@/src/components/SpeedGauge';
import {
  abrirOutbox,
  confirmar as confirmarEnvio,
  descartar,
  encolar,
  estado as estadoOutbox,
  marcarIntento,
  siguienteLote,
  type TipoMensaje,
} from '@/src/lib/outbox';
import {
  DetectorDinamico,
  UMBRALES_POR_DEFECTO,
  type EventoDinamico,
} from '@/src/lib/deteccionDinamica';
import {
  MedidorFrecuencia,
  anguloDesdeReferencia,
  magnitudDinamica,
  promediar,
  type Vector3,
} from '@/src/lib/dinamica';
import {
  CONTRACT_VERSION,
  isActionAllowedForRole,
  type CmdAction,
  type EventKind,
  type EventSeverity,
  type IssuerRole,
} from '@/src/contract/contract';

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
// Se importan del contrato en vez de redeclararse: la copia local se
// quedo en los cinco eventos originales y no vio los de dinamica que
// agrego el v1.2.0.

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

// Config del nodo (identidad + credenciales) guardada cifrada en el
// dispositivo (Keystore/Keychain vía expo-secure-store) — se pide una
// sola vez, no en cada arranque. El secreto es lo que autentica al nodo
// ante el backend (contrato v1.3.0); sin SecureStore quedaría en texto
// plano, y es un secreto real, no una preferencia de UI.
const NODE_CONFIG_KEY = 'sitciit.nodeConfig';

interface NodeConfig {
  brokerUrl: string;
  username: string;
  password: string;
  nodeId: string;
  unitId: string;
  role: NodeRole;
  nodeSecret: string;
}

const DEFAULT_SAMPLING_MS = 1000;
/** Intervalo del bucle de deteccion, independiente del de publicacion.
 *  Los eventos dinamicos (frenado, curva, golpe de via) duran decimas de
 *  segundo: a 150 ms se perdian. Es una sugerencia — Android entrega lo
 *  que el hardware permite, y por eso se mide el ritmo real. */
const DETECTION_INTERVAL_MS = 20;
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
// Umbral sobre la magnitud DINAMICA |a - g_ref| (sin gravedad). Antes
// eran 2.5 g sobre la magnitud cruda, que en reposo ya vale 1 g: el
// golpe real que disparaba era de ~1.5 g. Se fija ese valor explicito.
const DEFAULT_IMPACT_THRESHOLD_G = 1.5;
// >1.5x el umbral se considera critical, si no warning — evita que todo
// impacto sea "critical" sin distinción.
/** Muestras en reposo que se promedian al calibrar (~2 s a 20 ms). */
const CALIB_MUESTRAS = 100;
/** Cada cuanto se refresca lo que se ve. El bucle de deteccion corre a
 *  la velocidad del sensor; la pantalla no necesita ir tan rapido y a
 *  50 renders/s se congela. */
const UI_REFRESH_MS = 200;
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

  // Identidad del nodo (contrato: nodeId, unitId, role, nodeSecret)
  const [nodeId, setNodeId] = useState('unit-01-a');
  const [unitId, setUnitId] = useState('unit-01');
  const [isBackup, setIsBackup] = useState(false);
  const role: NodeRole = isBackup ? 'backup' : 'primary';
  const [nodeSecret, setNodeSecret] = useState('');
  const seqRef = useRef(0);

  // null mientras se lee SecureStore; false = sin configurar (mostrar
  // formulario); true = configurado (mostrar resumen + Reconfigurar).
  const [configured, setConfigured] = useState<boolean | null>(null);

  // Al montar: si ya se guardó una config antes, se conecta sola — sin
  // esto habría que volver a escribir todo a mano en cada arranque, que
  // es justo lo frágil que se quería evitar.
  useEffect(() => {
    (async () => {
      const raw = await SecureStore.getItemAsync(NODE_CONFIG_KEY);
      if (!raw) {
        setConfigured(false);
        return;
      }
      const cfg: NodeConfig = JSON.parse(raw);
      setBrokerUrl(cfg.brokerUrl);
      setUsername(cfg.username);
      setPassword(cfg.password);
      setNodeId(cfg.nodeId);
      setUnitId(cfg.unitId);
      setIsBackup(cfg.role === 'backup');
      setNodeSecret(cfg.nodeSecret);
      setConfigured(true);
      // Se le pasa cfg explícito en vez de depender del estado recién
      // asignado arriba (los setState de este mismo efecto todavía no se
      // reflejan en las variables locales de esta función).
      connect(cfg);
    })();
    // Solo al montar: connect se llama con cfg explícito, no necesita
    // volver a dispararse por cambios de estado.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function guardarYConectar() {
    const cfg: NodeConfig = { brokerUrl, username, password, nodeId, unitId, role, nodeSecret };
    await SecureStore.setItemAsync(NODE_CONFIG_KEY, JSON.stringify(cfg));
    setConfigured(true);
    connect(cfg);
  }

  async function reconfigurar() {
    disconnect();
    await SecureStore.deleteItemAsync(NODE_CONFIG_KEY);
    setConfigured(false);
  }

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

  // Volcadura: referencia "vertical" tomada de la primera lectura (se
  // puede recalibrar a mano con el botón de abajo). rolloverSinceRef
  // marca cuándo empezó a estar inclinado; solo dispara si se sostiene
  // ROLLOVER_SUSTAIN_MS, y no repite mientras siga volcado.
  // Vector de gravedad de referencia, promediado en reposo: es un
  // vector, no una medicion puntual, asi que no lleva timestamp.
  const referenceGravityRef = useRef<Vector3 | null>(null);
  const rolloverSinceRef = useRef<number | null>(null);
  const rolloverFiredRef = useRef(false);
  const [lastRolloverAngle, setLastRolloverAngle] = useState<number | null>(null);
  // Sesgo del giroscopio: parado rara vez marca cero exacto, y ese error
  // se acumula al integrar. Se mide al recalibrar y se resta despues.
  const gyroBiasRef = useRef<Vector3 | null>(null);
  const [calibrando, setCalibrando] = useState(false);
  const muestrasCalibRef = useRef<{ accel: Vector3[]; gyro: Vector3[] }>({ accel: [], gyro: [] });
  // Frecuencia efectiva del sensor: setUpdateInterval es una sugerencia,
  // Android entrega lo que el hardware permite.
  const medidorAccelRef = useRef(new MedidorFrecuencia());
  const [hzReal, setHzReal] = useState<number | null>(null);
  // Cola de salida: lo pendiente de entregar. Se reporta en el
  // heartbeat (pendingOutbox del contrato) y se ve en pantalla.
  const [pendientes, setPendientes] = useState(0);
  const pendientesRef = useRef(0);
  pendientesRef.current = pendientes;
  const drenandoRef = useRef(false);
  // Detector de dinamica de marcha: se alimenta con cada muestra del
  // bucle de deteccion (no con las publicadas) porque un frenado o un
  // golpe de via duran decimas de segundo.
  const detectorRef = useRef(new DetectorDinamico());
  const [ejeAprendido, setEjeAprendido] = useState(false);
  const [ultimoDinamico, setUltimoDinamico] = useState<string | null>(null);
  const calibrandoRef = useRef(false);
  const anguloRef = useRef<number | null>(null);

  // Refresco de la UI desacoplado del sensor: lee las refs que el bucle
  // de deteccion va llenando y actualiza el estado a ritmo humano.
  useEffect(() => {
    const id = setInterval(() => {
      if (readingRef.current) setReading(readingRef.current);
      setLastRolloverAngle(anguloRef.current);
      setHzReal(medidorAccelRef.current.hz);
      setEjeAprendido(detectorRef.current.tieneEjeAvance);
    }, UI_REFRESH_MS);
    return () => clearInterval(id);
  }, []);

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
  const [mode, setMode] = useState<NodeMode>('normal');
  // Alarma disparada por comando (trigger_alarm / stop_alarm). El sonido
  // llega con expo-av en la Fase 2; por ahora vibracion, que no depende
  // del volumen del telefono.
  const [alarmOn, setAlarmOn] = useState(false);
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
  useEffect(() => {
    if (!alarmOn) {
      Vibration.cancel();
      return;
    }
    // Patron repetido: espera 0, vibra 600ms, pausa 400ms.
    Vibration.vibrate([0, 600, 400], true);
    return () => Vibration.cancel();
  }, [alarmOn]);

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
  // Aproximación de movimiento: las sacudidas no permiten medir velocidad real.
  const inertialSpeedKmhRef = useRef(0);
  const kineticEnergyRef = useRef(0);
  const lastInertialTimeRef = useRef(Date.now());
  const lastUiUpdateRef = useRef(0);
  const gyroReadingRef = useRef<GyroscopeMeasurement | null>(null);

  function updateInertialSpeed(m: AccelerometerMeasurement) {
    const now = Date.now();
    const dt = Math.min(1.0, Math.max(0, (now - lastInertialTimeRef.current) / 1000));
    if (dt === 0) return;
    lastInertialTimeRef.current = now;

    const accelDev = Math.abs(magnitude(m) - 1.0);
    // Los giros no añaden velocidad; limitar golpes y filtrar por tiempo real.
    const instantEnergy = Math.min(0.6, Math.max(0, accelDev - 0.08)) * 0.45;
    const filterWeight = 1 - Math.exp(-dt / 0.8);
    kineticEnergyRef.current += (instantEnergy - kineticEnergyRef.current) * filterWeight;
    const energy = kineticEnergyRef.current;

    // Aproximación conservadora para caminar sin velocidad GPS disponible.
    const SPEED_SCALE = 22;
    const MAX_INERTIAL_KMH = 8;
    const ACCEL_RATE = 0.5;
    const BRAKE_RATE = 1.5;

    const targetSpeedKmh = Math.min(MAX_INERTIAL_KMH, Math.max(0, energy - 0.025) * SPEED_SCALE);

    let currentKmh = inertialSpeedKmhRef.current;
    if (targetSpeedKmh > currentKmh) {
      // Limitar la subida a 1 km/h por segundo.
      currentKmh += Math.min(dt, (targetSpeedKmh - currentKmh) * (1 - Math.exp(-dt * ACCEL_RATE)));
    } else {
      // Desaceleración progresiva
      currentKmh -= (currentKmh - targetSpeedKmh) * (1 - Math.exp(-dt * BRAKE_RATE));
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
    // Sin guarda de conexion: el mensaje va a la cola y sale cuando
    // haya red. Esa guarda era justo lo que perdia los eventos.

    seqRef.current += 1;
    const g = gpsRef.current;
    const payload = JSON.stringify({
      contractVersion: CONTRACT_VERSION,
      msgId: uuidv4(),
      nodeId,
      unitId,
      role,
      nodeSecret,
      seq: seqRef.current,
      ts: Date.now(),
      type: 'event',
      kind,
      severity,
      ...(value != null ? { value } : {}),
      ...(threshold != null ? { threshold } : {}),
      ...(g ? { gps: { lat: g.lat, lon: g.lon } } : {}),
    });

    // A la cola en vez de directo: un impacto detectado en un tunel se
    // perdia porque publishEvent salia temprano sin conexion.
    void encolarMensaje(`sitciit/${nodeId}/event`, payload, 'event');
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
      // La deteccion va a su propio ritmo; la publicacion MQTT sigue
      // usando samplingMs.
      Accelerometer.setUpdateInterval(DETECTION_INTERVAL_MS);
      sub = Accelerometer.addListener((m) => {
        readingRef.current = m;
        // La UI NO se actualiza aqui: a 20 ms serian 50 renders por
        // segundo y la pantalla se congela. El bucle de deteccion corre
        // a la velocidad del sensor y un intervalo aparte refresca lo
        // que se ve (ver el efecto de refresco de UI mas abajo).
        medidorAccelRef.current.registrar();

        // Calibracion: acumula muestras en reposo para promediarlas.
        if (muestrasCalibRef.current.accel.length < CALIB_MUESTRAS && calibrandoRef.current) {
          muestrasCalibRef.current.accel.push(m);
        }

        const dinamica = magnitudDinamica(m, referenceGravityRef.current);
        movementEmaRef.current = movementEmaRef.current * 0.7 + dinamica * 0.3;

        // Dinamica de marcha: frenado, curva, golpe con eje e
        // irregularidad de via. Se alimenta con cada muestra; el
        // detector lleva su propia histeresis y tiempo de espera.
        const evDin = detectorRef.current.procesar({
          accel: m,
          gravedadRef: referenceGravityRef.current,
          velocidadMs: gpsRef.current?.speedMs ?? null,
          ahora: Date.now(),
        });
        if (evDin) emitirEventoDinamico(evDin);
        evaluateMovement();
        updateInertialSpeed(m);

        // Impacto: flanco de subida sobre el umbral, no repite mientras
        // se mantenga arriba. Se mide sobre la magnitud dinamica, que
        // vale 0 en reposo: la cruda incluye la gravedad y desplazaba el
        // umbral en 1 g.
        // El impacto lo detecta ahora DetectorDinamico (arriba), que
        // ademas identifica el eje del golpe. Este detector media lo
        // mismo y emitia un segundo evento con identico valor: en las
        // pruebas salian pares impact=2.11 / dynamic_impact=2.11.

        // Volcadura: primera lectura calibra "vertical"; después se mide
        // el ángulo respecto a esa referencia (se puede recalibrar a mano).
        if (!referenceGravityRef.current) {
          referenceGravityRef.current = m;
        } else {
          const angle = anguloDesdeReferencia(m, referenceGravityRef.current);
          anguloRef.current = angle;
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
  }, [samplingMs, status, nodeId, unitId, role, nodeSecret, impactThresholdG]);

  // Suscripción al giroscopio real — misma frecuencia que el acelerómetro,
  // alimenta el indicador de movimiento y el estimador inercial de velocidad.
  useEffect(() => {
    let sub: { remove: () => void } | null = null;
    try {
      Gyroscope.setUpdateInterval(DETECTION_INTERVAL_MS);
      sub = Gyroscope.addListener((g) => {
        gyroReadingRef.current = g;
        if (calibrandoRef.current && muestrasCalibRef.current.gyro.length < CALIB_MUESTRAS) {
          muestrasCalibRef.current.gyro.push(g);
        }
        rotationEmaRef.current = rotationEmaRef.current * 0.7 + gyroMagnitude(g) * 0.3;
        evaluateMovement();
        if (readingRef.current) {
          updateInertialSpeed(readingRef.current);
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
  }, [samplingMs, status, nodeId, unitId, role, nodeSecret, doorOpenLux, doorClosedLux]);

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

  // Acepta un cfg explícito (usado al auto-conectar desde SecureStore,
  // justo tras leerlo, cuando el estado todavía no se actualizó en esta
  // misma función) — el botón "Guardar y conectar" también lo pasa así
  // por lo mismo. Sin cfg, usa el estado actual (no debería pasar hoy,
  // pero deja la función utilizable sola si algo más la llama).
  function connect(cfg?: NodeConfig) {
    const effective: NodeConfig = cfg ?? { brokerUrl, username, password, nodeId, unitId, role, nodeSecret };

    clientRef.current?.end(true);
    setStatus('connecting');
    appendLog(`Conectando a ${effective.brokerUrl}...`);

    const client = mqtt.connect(effective.brokerUrl, {
      username: effective.username,
      password: effective.password,
      clientId: effective.nodeId,
      // clean:false + clientId estable = el broker guarda los comandos
      // emitidos mientras el nodo esta sin señal y se los entrega al
      // reconectar (ADR 0002 de sit-ciit-infra, paso 7 del guion).
      clean: false,
      reconnectPeriod: 2000,
    });

    client.on('connect', () => {
      setStatus('connected');
      appendLog('Conectado');
      client.subscribe(`sitciit/${effective.nodeId}/cmd`, { qos: 1 }, (err) => {
        if (err) appendLog(`Fallo al suscribirse a comandos: ${err.message}`);
        else appendLog('Escuchando comandos del centro de control');
      });
    });

    client.on('message', (topic, payload) => {
      if (topic.endsWith('/cmd')) handleCommand(payload);
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
    if (!m) return;

    seqRef.current += 1;
    const g = gpsRef.current;
    const payload = JSON.stringify({
      contractVersion: CONTRACT_VERSION,
      msgId: uuidv4(),
      nodeId,
      unitId,
      role,
      nodeSecret,
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

    void encolarMensaje(`sitciit/${nodeId}/telemetry`, payload, 'telemetry');
  }

  // Auto-publicación al ritmo de samplingMs mientras está conectado.
  useEffect(() => {
    if (!autoPublish || status !== 'connected') return;
    const intervalMs = Number(samplingMs) || DEFAULT_SAMPLING_MS;
    const id = setInterval(publishTelemetry, intervalMs);
    return () => clearInterval(id);
  }, [autoPublish, status, samplingMs, nodeId, unitId, role, nodeSecret]);

  /** Confirma un comando hacia la nube. El backend mueve el estado del
   *  comando con esto (sent -> delivered -> executed/rejected). */
  function publishAck(cmdId: string, ackStatus: 'delivered' | 'executed' | 'rejected', reason?: string) {
    const client = clientRef.current;
    if (!client) return;

    seqRef.current += 1;
    const payload = JSON.stringify({
      contractVersion: CONTRACT_VERSION,
      msgId: uuidv4(),
      nodeId,
      unitId,
      role,
      nodeSecret,
      seq: seqRef.current,
      ts: Date.now(),
      type: 'ack',
      cmdId,
      status: ackStatus,
      ...(reason ? { reason } : {}),
    });

    client.publish(`sitciit/${nodeId}/ack`, payload, { qos: 1 }, (err) => {
      if (err) appendLog(`Fallo al confirmar ${ackStatus}: ${err.message}`);
    });
  }

  /** Comandos ya ejecutados, para no repetir la accion si el broker
   *  reentrega el mismo cmdId (QoS 1 garantiza "al menos una vez"). */
  const cmdVistosRef = useRef<Set<string>>(new Set());

  function handleCommand(payload: Buffer | Uint8Array) {
    let cmd: {
      cmdId?: string;
      action?: CmdAction;
      params?: Record<string, unknown>;
      issuedBy?: { role?: IssuerRole };
    };
    try {
      cmd = JSON.parse(payload.toString());
    } catch {
      appendLog('Comando recibido con JSON invalido, descartado');
      return;
    }

    const { cmdId, action } = cmd;
    if (!cmdId || !action) {
      appendLog('Comando sin cmdId o accion, descartado');
      return;
    }

    // Acuse de recibo inmediato, antes de ejecutar: el centro de control
    // ve "Entregado" aunque la accion tarde o falle.
    publishAck(cmdId, 'delivered');

    if (cmdVistosRef.current.has(cmdId)) {
      appendLog(`Comando ${action} repetido, ya ejecutado`);
      return;
    }

    // El backend ya valido la autoridad, pero el nodo revalida: es la
    // segunda linea de defensa que pide el contrato.
    const rol = cmd.issuedBy?.role;
    if (rol && !isActionAllowedForRole(action, rol)) {
      appendLog(`Comando ${action} rechazado: el rol ${rol} no puede emitirlo`);
      publishAck(cmdId, 'rejected', `rol ${rol} no autorizado para ${action}`);
      return;
    }

    const params = cmd.params ?? {};
    try {
      switch (action) {
        case 'set_sampling_rate': {
          const ms = Number(params.samplingMs);
          if (!Number.isFinite(ms) || ms < 100 || ms > 60000) {
            throw new Error('samplingMs fuera de rango (100-60000)');
          }
          setSamplingMs(String(Math.round(ms)));
          appendLog(`Muestreo ajustado a ${Math.round(ms)} ms`);
          break;
        }
        case 'set_mode': {
          const m = String(params.mode);
          if (m !== 'normal' && m !== 'inspection' && m !== 'alarm') {
            throw new Error(`modo desconocido: ${m}`);
          }
          setMode(m);
          appendLog(`Modo cambiado a ${m}`);
          break;
        }
        case 'trigger_alarm': {
          setMode('alarm');
          setAlarmOn(true);
          appendLog('ALARMA ACTIVADA');
          break;
        }
        case 'stop_alarm': {
          setAlarmOn(false);
          setMode('normal');
          appendLog('Alarma detenida');
          break;
        }
        case 'set_thresholds': {
          const g = Number(params.impactG);
          if (!Number.isFinite(g) || g <= 0) throw new Error('impactG invalido');
          setImpactThresholdG(String(g));
          appendLog(`Umbral de impacto ajustado a ${g} g`);
          break;
        }
        case 'toggle_sensor': {
          // Los sensores se activan segun disponibilidad real del
          // dispositivo (Fase 2); apagarlos a mano queda pendiente.
          throw new Error('toggle_sensor no implementado todavia');
        }
        default:
          throw new Error(`accion no soportada: ${action}`);
      }

      cmdVistosRef.current.add(cmdId);
      publishAck(cmdId, 'executed');
    } catch (err) {
      const motivo = err instanceof Error ? err.message : String(err);
      appendLog(`Comando ${action} rechazado: ${motivo}`);
      publishAck(cmdId, 'rejected', motivo);
    }
  }


  /** Encola un mensaje saliente. Nada se publica directo: si no hay
   *  conexion, el mensaje espera en SQLite en vez de perderse. */
  async function encolarMensaje(topic: string, payload: string, tipo: TipoMensaje) {
    try {
      await encolar(topic, payload, tipo);
      const e = await estadoOutbox();
      setPendientes(e.total);
      void drenar();
    } catch (err) {
      appendLog(`No se pudo encolar ${tipo}: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Vacia la cola por lotes mientras haya conexion. Un mensaje solo se
   *  borra cuando el broker confirma (QoS 1): si el envio falla a mitad,
   *  al reconectar se retoma donde quedo. */
  async function drenar() {
    if (drenandoRef.current) return;
    const client = clientRef.current;
    if (!client || !client.connected) return;

    drenandoRef.current = true;
    try {
      for (;;) {
        const lote = await siguienteLote();
        if (lote.length === 0) break;

        for (const m of lote) {
          if (!clientRef.current?.connected) return;

          const ok = await new Promise<boolean>((resolve) => {
            clientRef.current!.publish(m.topic, m.payload, { qos: 1 }, (err) =>
              resolve(!err),
            );
          });

          if (ok) {
            await confirmarEnvio(m.id);
          } else {
            await marcarIntento(m.id);
            // Tras varios fallos el payload es el problema, no la red:
            // se descarta para que no bloquee lo que viene detras.
            if (m.intentos >= 4) {
              await descartar(m.id);
              appendLog(`Descartado un ${m.tipo} tras 5 intentos fallidos`);
            }
            return; // sin red: se reintenta al reconectar
          }
        }
      }
    } catch (err) {
      appendLog(`Error vaciando la cola: ${err instanceof Error ? err.message : err}`);
    } finally {
      drenandoRef.current = false;
      const e = await estadoOutbox();
      setPendientes(e.total);
    }
  }

  // Abre la cola al arrancar y reporta lo que quedo pendiente de una
  // sesion anterior (la app pudo cerrarse sin cobertura).
  useEffect(() => {
    void (async () => {
      try {
        await abrirOutbox();
        const e = await estadoOutbox();
        setPendientes(e.total);
        if (e.total > 0) {
          appendLog(`${e.total} mensajes pendientes de la sesion anterior`);
        }
      } catch (err) {
        appendLog(`No se pudo abrir la cola: ${err instanceof Error ? err.message : err}`);
      }
    })();
  }, []);

  // Reintento periodico: cubre el caso de recuperar la red sin que el
  // cliente MQTT emita 'connect' (por ejemplo al volver de segundo plano).
  useEffect(() => {
    const id = setInterval(() => void drenar(), 5000);
    return () => clearInterval(id);
  }, []);

  /** Publica un evento de dinamica como mensaje `event` del contrato
   *  v1.2.0. El eje del golpe va en el log local: el contrato no tiene
   *  campo para el (se evaluara en un 1.3.0 si resulta util). */
  function emitirEventoDinamico(ev: EventoDinamico) {
    const detalle = 'eje' in ev ? ` (${ev.eje})` : '';
    appendLog(`${ev.kind}${detalle}: ${ev.value.toFixed(2)} g`);
    setUltimoDinamico(`${ev.kind}${detalle} ${ev.value.toFixed(2)} g`);
    publishEvent(ev.kind, ev.severity, ev.value, ev.threshold);
  }

  function publishHeartbeat() {
    const client = clientRef.current;
    // Sin guarda de conexion: a la cola (ver encolarMensaje).

    seqRef.current += 1;
    const level = batteryLevelRef.current;
    const payload = JSON.stringify({
      contractVersion: CONTRACT_VERSION,
      msgId: uuidv4(),
      nodeId,
      unitId,
      role,
      nodeSecret,
      seq: seqRef.current,
      ts: Date.now(),
      type: 'heartbeat',
      // getBatteryLevelAsync/useBatteryLevel devuelven -1 cuando el
      // dispositivo no reporta nivel de batería (ver expo-battery) — el
      // contrato no acepta negativos, así que se omite en vez de mandarlo.
      ...(level != null && level >= 0 ? { batteryPct: Math.round(level * 100) } : {}),
      pendingOutbox: pendientesRef.current,
      samplingMs: Number(samplingMs) || DEFAULT_SAMPLING_MS,
      capabilities: capabilitiesRef.current,
      mode: modeRef.current,
    });

    // Heartbeat no se registra en el log de UI (saldría uno cada 5s
    // ahogando lo demás) — solo se avisa si falla.
    void encolarMensaje(`sitciit/${nodeId}/heartbeat`, payload, 'heartbeat');
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
  }, [status, nodeId, unitId, role, nodeSecret]);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.scrollContent}>
      <Text style={styles.title}>Modo Nodo</Text>

      {alarmOn ? (
        <Text style={styles.alarmBanner}>ALARMA ACTIVA — comando del centro de control</Text>
      ) : null}

      <Text style={styles.sectionLabel}>
        Acelerómetro{hzReal != null ? ` — ${hzReal.toFixed(0)} Hz reales` : ''}
      </Text>
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

      {configured === null ? (
        <Text style={styles.reading}>Cargando configuración guardada...</Text>
      ) : configured ? (
        <>
          <Text style={styles.sectionLabel}>Nodo configurado</Text>
          <Text style={styles.reading}>
            {nodeId} ({unitId}, {role === 'primary' ? 'primario' : 'respaldo'})
          </Text>
          <Button title="Reconfigurar" onPress={reconfigurar} />
        </>
      ) : (
        <>
          <Text style={styles.sectionLabel}>Identidad del nodo</Text>
          <TextInput style={styles.input} placeholderTextColor="#999999" value={nodeId} onChangeText={setNodeId} placeholder="nodeId" autoCapitalize="none" />
          <TextInput style={styles.input} placeholderTextColor="#999999" value={unitId} onChangeText={setUnitId} placeholder="unitId" autoCapitalize="none" />
          <View style={styles.row}>
            <Text>Rol: {role}</Text>
            <Switch value={isBackup} onValueChange={setIsBackup} />
          </View>
          {/* Lo genera el CRUD de Nodos en el dashboard (rol control_center)
              — se pega una sola vez, aquí, y luego se guarda cifrado en el
              celular; ver contrato v1.3.0. */}
          <TextInput style={styles.input} placeholderTextColor="#999999" value={nodeSecret} onChangeText={setNodeSecret} placeholder="secreto del nodo (dashboard → Nodos)" secureTextEntry autoCapitalize="none" />

          <Text style={styles.sectionLabel}>Conexión MQTT</Text>
          <TextInput style={styles.input} placeholderTextColor="#999999" value={brokerUrl} onChangeText={setBrokerUrl} placeholder="ws://<ip>:9001" autoCapitalize="none" />
          <TextInput style={styles.input} placeholderTextColor="#999999" value={username} onChangeText={setUsername} placeholder="usuario" autoCapitalize="none" />
          <TextInput style={styles.input} placeholderTextColor="#999999" value={password} onChangeText={setPassword} placeholder="contraseña" secureTextEntry autoCapitalize="none" />

          <Button title="Guardar y conectar" onPress={guardarYConectar} disabled={status === 'connecting' || !nodeSecret} />
        </>
      )}
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
        title={calibrando ? 'Calibrando, mantén el equipo quieto…' : 'Calibrar en reposo (vertical + giroscopio)'}
        disabled={calibrando}
        onPress={() => {
          // Promediar varias muestras en reposo, en vez de tomar una
          // sola: una lectura suelta arrastra el ruido del sensor a la
          // referencia, y todo lo demás se mide contra ella.
          muestrasCalibRef.current = { accel: [], gyro: [] };
          calibrandoRef.current = true;
          setCalibrando(true);
          appendLog('Calibrando: mantén el equipo quieto 2 s');

          setTimeout(() => {
            calibrandoRef.current = false;
            setCalibrando(false);
            const { accel, gyro } = muestrasCalibRef.current;

            const gravedad = promediar(accel);
            if (gravedad) {
              referenceGravityRef.current = gravedad;
              rolloverSinceRef.current = null;
              rolloverFiredRef.current = false;
            }
            // Sesgo del giroscopio: lo que marca estando quieto. Sin
            // restarlo, el error se acumula al integrar la rotación.
            const sesgo = promediar(gyro);
            if (sesgo) gyroBiasRef.current = sesgo;

            appendLog(
              gravedad
                ? `Calibrado con ${accel.length} muestras (sesgo giro: ${sesgo ? sesgo.x.toFixed(3) : 'n/d'})`
                : 'No se pudo calibrar: sin lecturas del acelerómetro'
            );
          }, CALIB_MUESTRAS * 20 + 500);
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
  alarmBanner: {
    backgroundColor: '#b8433f',
    color: '#ffffff',
    fontWeight: '700',
    fontSize: 13,
    textAlign: 'center',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 6,
    marginBottom: 10,
  },
  movementHint: { fontWeight: '400', opacity: 0.6, fontSize: 11 },
  status: { marginTop: 16, fontWeight: '600', color: '#111111' },
  logLine: { fontSize: 11, color: '#666666' },
});
