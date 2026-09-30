import { useState, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { useZendaTheme } from '@/src/theme/ZendaTheme';
import { BrandHeader, Card, Footer, Heading } from './ZendaUI';
import SpeedGauge from './SpeedGauge';
import MotionChart from './MotionChart';
import AxisMeters from './AxisMeters';
import type { Vector3 } from '@/src/lib/dinamica';

export interface DashboardData {
  nodeId: string; unitId: string; status: string; reading: Vector3 | null; speed: number | null; speedLabel: string;
  moving: boolean; battery: number | null; pending: number; hz: number | null; angle: number | null;
  lux: number | null; pressure: number | null; mag: Vector3 | null; door: string | null;
  gps: { lat: number; lon: number; accuracyM: number | null; fixTimestamp: number } | null;
  availability?: { name: string; available: boolean | null }[]; locationPermission?: string;
  alarm: boolean; log: string[]; lastEvent: string | null;
}
export default function NodeDashboard({ data: d, demo = false, children, demoControls }: { data: DashboardData; demo?: boolean; children?: ReactNode; demoControls?: ReactNode }) {
  const { colors: c } = useZendaTheme();
  const [tab, setTab] = useState('Resumen');
  const connected = d.status === 'connected';
  const connection = connected ? 'Conectado' : d.status === 'connecting' ? 'Conectando' : d.status === 'error' ? 'Error de conexión' : 'Sin conexión';
  const metric = (title: string, value: string, subtitle: string) => <View style={[s.metric, { backgroundColor: c.bg }]}><Text style={[s.label, { color: c.muted }]}>{title}</Text><Text style={[s.metricValue, { color: c.ink }]}>{value}</Text><Text style={[s.small, { color: c.muted }]}>{subtitle}</Text></View>;
  return <SafeAreaView edges={['top', 'left', 'right']} style={{ flex: 1, backgroundColor: c.bg }}>
    <StatusBar style={c.dark ? 'light' : 'dark'} />
    <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">
      <BrandHeader />
      <View style={s.pageHeading}><View style={{ flex: 1 }}><Text style={[s.eyebrow, { color: c.gold }]}>TU CAMINO, BAJO CONTROL</Text><Text style={[s.title, { color: c.ink }]}>Monitoreo</Text></View><View style={[s.chip, { backgroundColor: demo ? c.soft : c.tint }]}><Text style={{ color: demo ? c.accent : c.green, fontSize: 10, fontWeight: '700' }}>{demo ? '◉  DEMOSTRACIÓN' : '◉  DISPOSITIVO'}</Text></View></View>
      <Text style={[s.intro, { color: c.muted }]}>Una mirada clara a cada movimiento.</Text>
      <View style={[s.tabs, { backgroundColor: c.line }]}>{['Resumen', 'Sensores', 'Ajustes'].map(t => <Pressable key={t} onPress={() => setTab(t)} accessibilityRole="tab" accessibilityState={{ selected: tab === t }} style={[s.tab, tab === t && { backgroundColor: c.card }]}><Text style={{ color: tab === t ? c.accent : c.muted, fontWeight: '700', fontSize: 12 }}>{t}</Text></Pressable>)}</View>
      {demo && <View style={[s.demo, { borderColor: c.line }]}><Text style={[s.small, { color: c.muted }]}>Vista de prueba · Datos simulados, sin conexión a una unidad.</Text></View>}
      {d.alarm && <View accessibilityRole="alert" style={s.alarm}><Text style={{ color: '#FFF', fontWeight: '700' }}>Alarma activa{demo ? ' · Simulación' : ''}</Text><Text style={{ color: '#FFF', marginTop: 5 }}>Revisa el evento y el estado de la unidad.</Text></View>}
      {tab === 'Resumen' && <>
        <View style={s.unitCard}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}><Text style={s.unitLabel}>NODO DE MONITOREO</Text><Text style={{ color: '#E5CFAC', fontSize: 10 }}>{demo ? 'VISTA PREVIA' : 'SIT · CIIT'}</Text></View>
          <Text style={s.unitName}>{d.unitId.toUpperCase()}</Text>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}><Text style={{ color: '#EAD9DE', fontSize: 12 }}>{d.nodeId}</Text><View style={s.connection}><Text style={{ color: '#FFF', fontSize: 11 }}>● {demo ? 'Conexión simulada' : connection}</Text></View></View>
          <View style={s.unitBottom}><Text style={s.unitDetail}>▥  {d.battery == null ? 'Batería sin dato' : `${Math.round(d.battery * 100)}% batería`}</Text><Text style={s.unitDetail}>↥  {d.pending} pendientes</Text></View>
        </View>
        <Card><Heading title="Estado de marcha" aside={d.moving ? '● Movimiento' : d.reading ? '○ En reposo' : 'Sin lectura'} /><SpeedGauge speedKmh={d.speed} label={d.speedLabel} /><View style={s.metrics}>{metric('INCLINACIÓN', d.angle == null ? '—' : `${d.angle.toFixed(0)}°`, 'Respecto a la referencia')}{metric('MUESTREO', d.hz == null ? '—' : `${d.hz.toFixed(0)} Hz`, 'Frecuencia del sensor')}</View></Card>
        <Card><Heading title="Movimiento en 3 ejes" eyebrow="ACELERÓMETRO" aside="g" /><AxisMeters reading={d.reading} demo={demo} /></Card>
        <Card><Heading title="Ubicación" aside={d.gps ? 'GPS' : 'Esperando GPS'} /><View style={[s.location, { backgroundColor: c.tint }]}><Text style={{ fontSize: 28, color: c.green }}>⌖</Text><View style={{ flex: 1 }}><Text selectable style={{ color: c.ink, fontSize: 14, fontWeight: '600' }}>{d.gps ? `${d.gps.lat.toFixed(5)}, ${d.gps.lon.toFixed(5)}` : 'Sin ubicación disponible'}</Text><Text style={[s.small, { color: c.muted, marginTop: 4 }]}>{d.gps ? `Precisión ±${d.gps.accuracyM?.toFixed(0) ?? '—'} m · ${new Date(d.gps.fixTimestamp).toLocaleTimeString()}` : d.locationPermission === 'denied' ? 'Permiso de ubicación denegado. Habilítalo en los ajustes del teléfono.' : 'Activa la ubicación y revisa los permisos.'}</Text></View></View></Card>
        <Card><Heading title="Actividad reciente" aside={demo ? 'Ejemplo' : 'En este dispositivo'} />{d.lastEvent && <Text style={{ color: c.accent, fontSize: 12, marginBottom: 12 }}>{d.lastEvent}</Text>}{d.log.length ? d.log.map((line, i) => <View key={`${i}-${line}`} style={[s.logRow, { borderColor: c.line }]}><View style={[s.logDot, { backgroundColor: i === 0 ? c.gold : c.line }]} /><Text style={{ color: c.muted, flex: 1, fontSize: 12, lineHeight: 19 }}>{line}</Text></View>) : <Text style={{ color: c.muted, lineHeight: 21 }}>Sin actividad registrada. Aquí aparecerán la conexión y los eventos del dispositivo.</Text>}</Card>
      </>}
      {tab === 'Sensores' && <>
        {d.availability && <Card><Heading title="Disponibilidad de sensores" />{d.availability.map(sensor => <Text key={sensor.name} style={{ color: c.muted, fontSize: 12, lineHeight: 24 }}>{sensor.name}: {sensor.available === true ? 'Disponible' : sensor.available === false ? 'No disponible en este dispositivo' : 'Comprobando…'}</Text>)}</Card>}
        <Card><Heading eyebrow="LECTURA POR EJE" title="Aceleración en tiempo real" /><AxisMeters reading={d.reading} demo={demo} /><Text style={[s.note, { color: c.muted }]}>X recorre el ancho, Y el largo y Z sale de la pantalla. La orientación de montaje define su relación con el vehículo.</Text></Card>
        <Card><Heading title="Aceleración" aside="X · Y · Z" /><MotionChart reading={d.reading} demo={demo} /></Card>
        <Card><Heading title="Entorno" /><View style={s.metrics}>{metric('LUZ', d.lux == null ? '—' : `${d.lux.toFixed(0)} lx`, d.door === 'open' ? 'Puerta abierta (por luz)' : d.door === 'closed' ? 'Puerta cerrada (por luz)' : 'Puerta sin determinar')}{metric('PRESIÓN', d.pressure == null ? '—' : `${d.pressure.toFixed(0)}`, d.pressure == null ? 'Sin lectura disponible' : 'hPa · Barómetro')}</View></Card>
        <Card><Heading title="Campo magnético" aside="µT" /><View style={s.metrics}>{(['x', 'y', 'z'] as const).map(a => <View key={a} style={{ flex: 1 }}>{metric(`EJE ${a.toUpperCase()}`, d.mag ? d.mag[a].toFixed(1) : '—', 'µT')}</View>)}</View><Text style={[s.note, { color: c.muted }]}>Lectura del magnetómetro; no representa el rumbo.</Text></Card>
      </>}
      {tab === 'Ajustes' && <><Card><Heading eyebrow={demo ? 'EXPLORA LA PROPUESTA' : 'CONFIGURACIÓN DEL DISPOSITIVO'} title={demo ? 'Prueba el monitoreo' : 'Ajustes del nodo'} />{demo && <View style={{ marginBottom: 24 }}>{demoControls}</View>}{children}</Card><Text style={[s.note, { color: c.muted }]}>{demo ? 'La telemetría real, la calibración y la conexión a la unidad se realizan desde la app móvil.' : 'La configuración y las credenciales se guardan cifradas en este dispositivo.'}</Text></>}
      <Footer />
    </ScrollView>
  </SafeAreaView>;
}
const s = StyleSheet.create({
  scroll: { width: '100%', maxWidth: 620, alignSelf: 'center', paddingHorizontal: 20, paddingTop: 22, paddingBottom: 16 }, pageHeading: { flexDirection: 'row', alignItems: 'center', gap: 8 }, eyebrow: { fontSize: 9, letterSpacing: 1.8, fontWeight: '700', marginBottom: 8 }, title: { fontSize: 32, letterSpacing: -1, fontWeight: '700' }, chip: { paddingHorizontal: 10, paddingVertical: 8, borderRadius: 20 }, intro: { fontSize: 13, marginTop: 8, marginBottom: 24 }, tabs: { flexDirection: 'row', padding: 4, borderRadius: 14, marginBottom: 16 }, tab: { flex: 1, minHeight: 42, alignItems: 'center', justifyContent: 'center', borderRadius: 11 }, demo: { borderBottomWidth: 1, paddingBottom: 12, marginBottom: 16 }, small: { fontSize: 10, lineHeight: 16 }, unitCard: { backgroundColor: '#782D40', borderRadius: 24, padding: 22, marginBottom: 16, borderTopWidth: 3, borderTopColor: '#B9975B' }, unitLabel: { color: '#E5CFAC', fontSize: 10, fontWeight: '600', letterSpacing: 1.7 }, unitName: { color: '#FFF', fontSize: 27, letterSpacing: -0.5, fontWeight: '700', marginTop: 18, marginBottom: 9 }, connection: { borderRadius: 20, padding: 8, backgroundColor: '#8F4558' }, unitBottom: { borderTopWidth: 1, borderColor: '#A15C6D', marginTop: 20, paddingTop: 14, flexDirection: 'row', justifyContent: 'space-between' }, unitDetail: { color: '#F0E3E7', fontSize: 11 }, metric: { flex: 1, borderRadius: 13, padding: 12 }, metrics: { flexDirection: 'row', gap: 8 }, label: { fontSize: 9, letterSpacing: 1, fontWeight: '600' }, metricValue: { fontSize: 21, fontWeight: '600', marginVertical: 7 }, location: { flexDirection: 'row', gap: 15, alignItems: 'center', borderRadius: 14, padding: 15 }, logRow: { flexDirection: 'row', gap: 12, paddingVertical: 10, borderBottomWidth: 1, alignItems: 'center' }, logDot: { width: 7, height: 7, borderRadius: 5 }, note: { fontSize: 12, lineHeight: 20, marginTop: 15 }, alarm: { padding: 17, borderRadius: 16, backgroundColor: '#A73543', marginBottom: 15 },
});
