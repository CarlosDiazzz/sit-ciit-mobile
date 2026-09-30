import { useEffect, useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import NodeDashboard from '@/src/components/NodeDashboard';
import { Action } from '@/src/components/ZendaUI';
import NodeSettings, { type NodeSettingsValues } from '@/src/components/NodeSettings';
import type { Vector3 } from '@/src/lib/dinamica';
import { useZendaTheme } from '@/src/theme/ZendaTheme';

export default function NodoPreview() {
  const { colors: c } = useZendaTheme();
  const [values, setValues] = useState<NodeSettingsValues>({ nodeId: 'unit-01-a', unitId: 'unit-01', nodeSecret: '', brokerUrl: 'ws://192.168.1.100:9001', username: 'sitciit-dev', password: '', gpsIntervalMs: '5000', samplingMs: '1000', impactThresholdG: '1.5', doorOpenLux: '50', doorClosedLux: '10' });
  const [backup, setBackup] = useState(false);
  const [manual, setManual] = useState<Vector3 | null>(null);
  const unavailable = () => {};
  const [running, setRunning] = useState(true);
  const [moving, setMoving] = useState(true);
  const [alarm, setAlarm] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => { if (!running) return; const id = setInterval(() => setTick(v => v + 1), 400); return () => clearInterval(id); }, [running]);
  const [start] = useState(() => Date.now());
  const data = useMemo(() => { const t = tick * 0.37; const a = moving ? 0.14 : 0.005; return { x: Math.sin(t) * a, y: Math.cos(t * 1.3) * a * 0.7, z: 1 + Math.sin(t * 0.8) * a * 0.5 }; }, [tick, moving]);
  return <NodeDashboard demo data={{ nodeId: values.nodeId, unitId: values.unitId, status: 'idle', reading: manual ?? data, speed: moving ? 42 + Math.sin(tick * 0.1) * 2.4 : 0, speedLabel: 'Velocidad simulada · Vista de diseño', moving, battery: 0.86, pending: 0, hz: 50, angle: moving ? 3 : 0, lux: 8, pressure: 1013, mag: { x: 22.4, y: -8.1, z: 38.6 }, door: 'closed', gps: { lat: 16.1863, lon: -95.1954, accuracyM: 5, fixTimestamp: start }, alarm, lastEvent: alarm ? 'Impacto de ejemplo · Sin alerta enviada' : null, log: ['Ejemplo · Monitoreo de la unidad iniciado', 'Ejemplo · Referencia de sensores calibrada', 'Ejemplo · Configuración del nodo lista'] }} demoControls={<View style={{ gap: 12 }}><Text style={{ color: c.muted, lineHeight: 21, marginBottom: 5 }}>Explora los estados del panel. Estos controles solo cambian la demostración.</Text><Action secondary title={manual ? 'Volver a lecturas automáticas' : 'Controlar X / Y / Z manualmente'} onPress={() => setManual(v => v ? null : { x: 0, y: 0, z: 1 })} />{manual && <View style={{ gap: 12 }}>{(['x', 'y', 'z'] as const).map(axis => <View key={axis} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}><Text style={{ color: c.ink }}>Eje {axis.toUpperCase()}: {manual[axis].toFixed(2)} g</Text>{([-0.25, 0.25] as const).map(delta => <Pressable key={delta} accessibilityRole="button" accessibilityLabel={`${delta < 0 ? 'Restar' : 'Sumar'} ${axis.toUpperCase()}`} onPress={() => setManual(v => v && ({ ...v, [axis]: Math.max(-3, Math.min(3, v[axis] + delta)) }))} style={{ padding: 14, backgroundColor: c.soft, borderRadius: 12 }}><Text style={{ color: c.accent }}>{delta > 0 ? '+0.25' : '−0.25'}</Text></Pressable>)}</View>)}<Text style={{ color: c.muted }}>Cambia un eje y abre Sensores o Resumen para comprobar la barra. Rango de prueba: −3 a +3 g.</Text></View>}<Action title={running ? 'Pausar simulación' : 'Reanudar simulación'} onPress={() => setRunning(v => !v)} /><Action secondary title={moving ? 'Simular unidad en reposo' : 'Simular unidad en movimiento'} onPress={() => setMoving(v => !v)} /><Action secondary title={alarm ? 'Quitar alarma de ejemplo' : 'Mostrar alarma de ejemplo'} onPress={() => setAlarm(v => !v)} /></View>} >
    <NodeSettings preview values={values} onChange={(key, value) => setValues(v => ({ ...v, [key]: value }))}
      configured={false} status="idle" isBackup={backup} setIsBackup={setBackup} autoPublish={false} setAutoPublish={unavailable}
      calibrando={false} angle={null} onSave={unavailable} onReconfigure={unavailable} onDisconnect={unavailable} onPublish={unavailable} onCalibrate={unavailable} />
  </NodeDashboard>;
}
