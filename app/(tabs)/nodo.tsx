import { useEffect, useRef, useState } from 'react';
import { Button, StyleSheet, Switch, TextInput } from 'react-native';
import { Accelerometer, type AccelerometerMeasurement } from 'expo-sensors';
import mqtt, { type MqttClient } from 'mqtt';
import { v4 as uuidv4 } from 'uuid';

import { Text, View } from '@/components/Themed';

// Modo Nodo: conecta al broker de sit-ciit-infra y publica lecturas reales
// del acelerómetro del celular como mensajes `telemetry` del contrato.
// Pendiente para fases siguientes: GPS/luz/presión, detección de eventos
// en el borde (Fase 2), outbox SQLite (Fase 3), pantalla de configuración
// persistente y manejo de comandos (Fase 4).

type Status = 'idle' | 'connecting' | 'connected' | 'error';
type NodeRole = 'primary' | 'backup';

const DEFAULT_SAMPLING_MS = 1000;

function magnitude(m: AccelerometerMeasurement): number {
  return Math.sqrt(m.x * m.x + m.y * m.y + m.z * m.z);
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
