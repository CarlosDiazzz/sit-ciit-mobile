import { useRef, useState } from 'react';
import { Button, StyleSheet, TextInput } from 'react-native';
import mqtt, { type MqttClient } from 'mqtt';
import { v4 as uuidv4 } from 'uuid';

import { Text, View } from '@/components/Themed';

// Spike de la Fase 1: solo valida que mqtt.js conecte y publique desde
// Expo/React Native contra el broker de sit-ciit-infra (mosquitto, listener
// WebSocket en el puerto 9001). Todavía no lee sensores reales ni usa el
// contrato completo — eso viene después de confirmar que esto funciona.
//
// mqtt.js necesita el broker por WebSocket (ws://), no TCP crudo (mqtt://),
// porque React Native no tiene sockets TCP nativos sin una librería aparte.

type Status = 'idle' | 'connecting' | 'connected' | 'error';

export default function NodoScreen() {
  const [brokerUrl, setBrokerUrl] = useState(
    process.env.EXPO_PUBLIC_DEFAULT_MQTT_URL ?? 'ws://192.168.1.100:9001'
  );
  const [username, setUsername] = useState('sitciit-dev');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [log, setLog] = useState<string[]>([]);
  const clientRef = useRef<MqttClient | null>(null);

  function appendLog(line: string) {
    setLog((prev) => [`${new Date().toLocaleTimeString()}  ${line}`, ...prev].slice(0, 20));
  }

  function connect() {
    if (clientRef.current) {
      clientRef.current.end(true);
      clientRef.current = null;
    }

    setStatus('connecting');
    appendLog(`Conectando a ${brokerUrl}...`);

    const client = mqtt.connect(brokerUrl, {
      username,
      password,
      clientId: `spike-nodo-${uuidv4()}`,
      clean: true,
      reconnectPeriod: 0, // sin reintento automático: es un spike manual
    });

    client.on('connect', () => {
      setStatus('connected');
      appendLog('Conectado');
    });

    client.on('error', (err) => {
      setStatus('error');
      appendLog(`Error: ${err.message}`);
    });

    client.on('close', () => {
      appendLog('Conexión cerrada');
    });

    clientRef.current = client;
  }

  function disconnect() {
    clientRef.current?.end(true);
    clientRef.current = null;
    setStatus('idle');
    appendLog('Desconectado manualmente');
  }

  function publishTest() {
    const client = clientRef.current;
    if (!client || status !== 'connected') return;

    const payload = JSON.stringify({
      contractVersion: '1.0.0',
      msgId: uuidv4(),
      nodeId: 'spike-node',
      unitId: 'spike-unit',
      role: 'primary',
      seq: 0,
      ts: Date.now(),
      type: 'event',
      kind: 'threshold_exceeded',
      severity: 'info',
      value: 1,
    });

    client.publish('sitciit/spike-node/event', payload, { qos: 1 }, (err) => {
      if (err) {
        appendLog(`Fallo al publicar: ${err.message}`);
      } else {
        appendLog('Publicado en sitciit/spike-node/event');
      }
    });
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Modo Nodo — spike mqtt.js</Text>

      <TextInput
        style={styles.input}
        value={brokerUrl}
        onChangeText={setBrokerUrl}
        placeholder="ws://<ip-de-la-laptop>:9001"
        autoCapitalize="none"
      />
      <TextInput
        style={styles.input}
        value={username}
        onChangeText={setUsername}
        placeholder="usuario MQTT"
        autoCapitalize="none"
      />
      <TextInput
        style={styles.input}
        value={password}
        onChangeText={setPassword}
        placeholder="contraseña MQTT"
        secureTextEntry
        autoCapitalize="none"
      />

      <Button title="Conectar" onPress={connect} disabled={status === 'connecting'} />
      <View style={styles.spacer} />
      <Button title="Publicar mensaje de prueba" onPress={publishTest} disabled={status !== 'connected'} />
      <View style={styles.spacer} />
      <Button title="Desconectar" onPress={disconnect} disabled={status === 'idle'} />

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
  container: {
    flex: 1,
    padding: 16,
    paddingTop: 60,
  },
  title: {
    fontSize: 18,
    fontWeight: 'bold',
    marginBottom: 16,
  },
  input: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 6,
    padding: 8,
    marginBottom: 8,
  },
  spacer: {
    height: 8,
  },
  status: {
    marginTop: 16,
    fontWeight: '600',
  },
  logLine: {
    fontSize: 12,
    opacity: 0.8,
  },
});
