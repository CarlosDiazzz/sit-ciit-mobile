import { StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { useZendaTheme } from '@/src/theme/ZendaTheme';
import { Action, Heading } from './ZendaUI';

export interface NodeSettingsValues {
  nodeId: string; unitId: string; nodeSecret: string; brokerUrl: string; username: string; password: string;
  gpsIntervalMs: string; samplingMs: string; impactThresholdG: string; doorOpenLux: string; doorClosedLux: string;
}
export interface NodeSettingsProps {
  values: NodeSettingsValues;
  onChange: (key: keyof NodeSettingsValues, value: string) => void;
  configured: boolean | null; status: string; isBackup: boolean; autoPublish: boolean; calibrando: boolean;
  setIsBackup: (value: boolean) => void; setAutoPublish: (value: boolean) => void;
  onSave: () => void; onReconfigure: () => void; onDisconnect: () => void; onPublish: () => void; onCalibrate: () => void;
  angle: number | null; sustained?: boolean; preview?: boolean;
}
export default function NodeSettings(p: NodeSettingsProps) {
  const { colors: c } = useZendaTheme();
  const field = (key: keyof NodeSettingsValues, label: string, numeric = false, secret = false) => <View style={s.field} key={key}>
    <Text style={[s.label, { color: c.ink }]}>{label}</Text>
    <TextInput accessibilityLabel={label} testID={`setting-${key}`} style={[s.input, { color: c.ink, backgroundColor: c.bg, borderColor: c.line }]} value={p.values[key]} onChangeText={v => p.onChange(key, v)} autoCapitalize="none" autoCorrect={false} keyboardType={numeric ? 'decimal-pad' : 'default'} secureTextEntry={secret} />
  </View>;
  const divider = <View style={[s.divider, { backgroundColor: c.line }]} />;
  return <View>
    {p.preview && <Text style={[s.note, { color: c.accent }]}>Vista previa de los formularios móviles. Puedes editar los campos; las acciones de conexión, envío y calibración se habilitan en la app del teléfono. Los cambios de esta vista no se guardan ni se envían.</Text>}
    <Heading title="Identidad del nodo" />
    {p.configured === null ? <Text style={{ color: c.muted }}>Cargando configuración guardada…</Text> : p.configured ? <View style={{ gap: 12 }}><Text style={{ color: c.ink }}>{p.values.nodeId} · {p.values.unitId} · {p.isBackup ? 'Respaldo' : 'Primario'}</Text><Action title="Reconfigurar" onPress={p.onReconfigure} /></View> : <>
      {field('nodeId', 'Identificador del nodo')}{field('unitId', 'Identificador de la unidad')}
      <View style={s.switchRow}><Text style={{ flex: 1, color: c.ink }}>Nodo de respaldo</Text><Switch accessibilityLabel="Nodo de respaldo" value={p.isBackup} onValueChange={p.setIsBackup} /></View>
      {field('nodeSecret', 'Secreto del nodo', false, true)}
      {divider}<Heading title="Conexión MQTT" />
      {field('brokerUrl', 'Dirección del broker (ws:// o wss://)')}{field('username', 'Usuario MQTT')}{field('password', 'Contraseña MQTT', false, true)}
      <Action title="Guardar y conectar" onPress={p.onSave} disabled={p.preview || p.status === 'connecting' || !p.values.nodeSecret} />
    </>}
    <Text accessibilityLiveRegion="polite" style={[s.note, { color: c.muted }]}>Estado: {p.preview ? 'Vista previa sin conexión' : ({ idle: 'Desconectado', connected: 'Conectado', connecting: 'Conectando', error: 'Error de conexión' }[p.status] ?? p.status)}</Text>
    <Action secondary title="Desconectar" onPress={p.onDisconnect} disabled={p.preview || p.status === 'idle'} />
    {divider}<Heading title="GPS y muestreo" />
    {field('gpsIntervalMs', 'Intervalo de lecturas GPS (ms)', true)}{field('samplingMs', 'Intervalo de publicación (ms)', true)}
    <View style={s.switchRow}><Text style={{ flex: 1, color: c.ink }}>Publicar automáticamente</Text><Switch accessibilityLabel="Publicar automáticamente" value={p.autoPublish} onValueChange={p.setAutoPublish} disabled={p.preview || p.status !== 'connected'} /></View>
    <Action title="Publicar una vez" onPress={p.onPublish} disabled={p.preview || p.status !== 'connected'} />
    {divider}<Heading title="Impacto y calibración" />
    {field('impactThresholdG', 'Umbral de impacto (g)', true)}
    <Text style={[s.note, { color: c.muted }]}>Inclinación: {p.angle == null ? 'Sin lectura' : `${p.angle.toFixed(0)}° respecto a la referencia`}{p.sustained ? ' · Sostenida' : ''}</Text>
    <Action title={p.calibrando ? 'Calibrando, mantén el equipo quieto…' : 'Calibrar en reposo (vertical + giroscopio)'} onPress={p.onCalibrate} disabled={p.preview || p.calibrando} />
    {divider}<Heading title="Detección de puerta por luz" />
    {field('doorOpenLux', 'Puerta abierta: por encima de (lux)', true)}{field('doorClosedLux', 'Puerta cerrada: por debajo de (lux)', true)}
    <Text style={[s.note, { color: c.muted }]}>Los dos umbrales evitan cambios de estado por pequeñas variaciones de luz. Las lecturas de luz, presión y magnetómetro están en Sensores.</Text>
  </View>;
}
const s = StyleSheet.create({ field: { marginBottom: 14 }, label: { fontSize: 12, fontWeight: '600', marginBottom: 7 }, input: { minHeight: 48, borderRadius: 12, padding: 12, borderWidth: 1, fontSize: 14 }, switchRow: { flexDirection: 'row', gap: 12, alignItems: 'center', marginVertical: 12 }, divider: { height: 1, marginVertical: 24 }, note: { fontSize: 12, lineHeight: 20, marginBottom: 16 } });
