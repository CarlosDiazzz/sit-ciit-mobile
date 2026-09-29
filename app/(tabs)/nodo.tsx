import { useEffect, useRef, useState } from 'react';
import { Button, StyleSheet, Switch, TextInput } from 'react-native';
import { Accelerometer, type AccelerometerMeasurement } from 'expo-sensors';
import * as Location from 'expo-location';
import mqtt, { type MqttClient } from 'mqtt';
import { v4 as uuidv4 } from 'uuid';

import { Text, View } from '@/components/Themed';

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

interface GpsReading {
  lat: number;
  lon: number;
  speedMs: number | null;
  accuracyM: number | null;
  /** Solo para mostrar en pantalla — no se manda por MQTT. */
  speedSource: 'gps' | 'posicion' | null;
  /** Hora real de esta posición (loc.timestamp), para ver si está vieja. */
  fixTimestamp: number;
}

const DEFAULT_SAMPLING_MS = 1000;

function magnitude(m: AccelerometerMeasurement): number {
  return Math.sqrt(m.x * m.x + m.y * m.y + m.z * m.z);
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

  // GPS (única fuente de velocidad — ver comentario arriba)
  const [locationPermission, setLocationPermission] = useState<LocationPermission>('unknown');
  const [gps, setGps] = useState<GpsReading | null>(null);
  const gpsRef = useRef<GpsReading | null>(null);

  const [log, setLog] = useState<string[]>([]);
  function appendLog(line: string) {
    setLog((prev) => [`${new Date().toLocaleTimeString()}  ${line}`, ...prev].slice(0, 8));
  }

  // Disponibilidad del sensor (se checa una vez).
  useEffect(() => {
    Accelerometer.isAvailableAsync().then(setAccelAvailable);
  }, []);

  // Suscripción al acelerómetro real. readingRef siempre tiene el último
  // valor (para leerlo desde el intervalo de auto-publicación sin closures
  // obsoletas); `reading` en estado es solo para pintar la UI.
  useEffect(() => {
    const intervalMs = Number(samplingMs) || DEFAULT_SAMPLING_MS;
    Accelerometer.setUpdateInterval(intervalMs);
    const sub = Accelerometer.addListener((m) => {
      readingRef.current = m;
      setReading(m);
    });
    return () => sub.remove();
  }, [samplingMs]);

  // Permiso + suscripción al GPS real. speed/accuracy pueden llegar en
  // null hasta que el dispositivo consigue un "fix" (normal en interiores
  // o los primeros segundos al aire libre).
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
    let subscription: Location.LocationSubscription | null = null;
    let cancelled = false;
    let lastFix: { lat: number; lon: number; accuracyM: number; timestamp: number } | null = null;

    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (cancelled) return;
      setLocationPermission(status === 'granted' ? 'granted' : 'denied');
      if (status !== 'granted') return;

      const intervalMs = Number(samplingMs) || DEFAULT_SAMPLING_MS;
      subscription = await Location.watchPositionAsync(
        // High en vez de BestForNavigation: BestForNavigation espera un
        // fix multi-satélite más completo (más preciso pero más lento a
        // responder); en interiores/demo priorizamos frecuencia de
        // actualización sobre precisión centimétrica.
        { accuracy: Location.Accuracy.High, timeInterval: intervalMs, distanceInterval: 0 },
        (loc) => {
          const { latitude: lat, longitude: lon, speed, accuracy } = loc.coords;

          // Si el proveedor repite el mismo fix (timestamp sin avanzar),
          // no es una medición nueva — no recalcular con eso, se
          // conserva la última velocidad válida conocida en vez de
          // "parpadear" a un valor calculado con tiempo ~0.
          if (lastFix && loc.timestamp === lastFix.timestamp) return;

          let speedMs: number | null = speed != null && speed >= 0 ? speed : null;
          let speedSource: GpsReading['speedSource'] = speedMs != null ? 'gps' : null;

          if (speedMs == null && lastFix) {
            const dtSec = (loc.timestamp - lastFix.timestamp) / 1000;
            if (dtSec > 0.2) {
              const distanceM = haversineMeters(lastFix, { lat, lon });
              const noiseFloorM = Math.max(lastFix.accuracyM, accuracy ?? 0, 5);
              speedMs = distanceM < noiseFloorM ? 0 : distanceM / dtSec;
              speedSource = 'posicion';
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
        }
      );
    })();

    return () => {
      cancelled = true;
      subscription?.remove();
    };
  }, [samplingMs]);

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
      contractVersion: '1.0.0',
      msgId: uuidv4(),
      nodeId,
      unitId,
      role,
      seq: seqRef.current,
      ts: Date.now(),
      type: 'telemetry',
      accel: { x: m.x, y: m.y, z: m.z },
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

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Modo Nodo</Text>

      <Text style={styles.sectionLabel}>Acelerómetro</Text>
      <Text style={styles.reading}>
        {accelAvailable === false
          ? 'No disponible en este dispositivo'
          : reading
            ? `x=${reading.x.toFixed(3)}  y=${reading.y.toFixed(3)}  z=${reading.z.toFixed(3)}  |g|=${magnitude(reading).toFixed(3)}`
            : 'Esperando lecturas...'}
      </Text>

      <Text style={styles.sectionLabel}>GPS (fuente de velocidad)</Text>
      <Text style={styles.reading}>
        {locationPermission === 'denied'
          ? 'Permiso de ubicación denegado'
          : locationPermission === 'unknown'
            ? 'Pidiendo permiso...'
            : gps
              ? `${gps.speedMs != null && gps.speedMs >= 0 ? `${(gps.speedMs * 3.6).toFixed(1)} km/h` : 'sin velocidad todavía'}` +
                `${gps.speedSource === 'posicion' ? ' (estimada por posición)' : ''}` +
                `  (±${gps.accuracyM?.toFixed(0) ?? '?'} m, fix ${new Date(gps.fixTimestamp).toLocaleTimeString()})`
              : 'Esperando fix de GPS...'}
      </Text>

      <Text style={styles.sectionLabel}>Identidad del nodo</Text>
      <TextInput style={styles.input} value={nodeId} onChangeText={setNodeId} placeholder="nodeId" autoCapitalize="none" />
      <TextInput style={styles.input} value={unitId} onChangeText={setUnitId} placeholder="unitId" autoCapitalize="none" />
      <View style={styles.row}>
        <Text>Rol: {role}</Text>
        <Switch value={isBackup} onValueChange={setIsBackup} />
      </View>

      <Text style={styles.sectionLabel}>Conexión MQTT</Text>
      <TextInput style={styles.input} value={brokerUrl} onChangeText={setBrokerUrl} placeholder="ws://<ip>:9001" autoCapitalize="none" />
      <TextInput style={styles.input} value={username} onChangeText={setUsername} placeholder="usuario" autoCapitalize="none" />
      <TextInput style={styles.input} value={password} onChangeText={setPassword} placeholder="contraseña" secureTextEntry autoCapitalize="none" />

      <Button title="Conectar" onPress={connect} disabled={status === 'connecting'} />
      <View style={styles.spacer} />
      <Button title="Desconectar" onPress={disconnect} disabled={status === 'idle'} />

      <Text style={styles.sectionLabel}>Muestreo</Text>
      <TextInput
        style={styles.input}
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

      <Text style={styles.status}>Estado: {status}</Text>
      {log.map((line, i) => (
        <Text key={i} style={styles.logLine}>
          {line}
        </Text>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, paddingTop: 50 },
  title: { fontSize: 18, fontWeight: 'bold', marginBottom: 8 },
  sectionLabel: { fontSize: 13, fontWeight: '600', opacity: 0.7, marginTop: 12, marginBottom: 4 },
  reading: { fontVariant: ['tabular-nums'], fontSize: 14 },
  input: { borderWidth: 1, borderColor: '#ccc', borderRadius: 6, padding: 8, marginBottom: 6 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  spacer: { height: 8 },
  status: { marginTop: 16, fontWeight: '600' },
  logLine: { fontSize: 11, opacity: 0.7 },
});
