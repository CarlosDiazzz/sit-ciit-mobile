import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useZendaTheme } from '@/src/theme/ZendaTheme';
import type { Vector3 } from '@/src/lib/dinamica';

const axes = [{ key: 'x', color: '#BA6378', name: 'Lateral' }, { key: 'y', color: '#B9904B', name: 'Longitudinal' }, { key: 'z', color: '#419C97', name: 'Vertical' }] as const;
export default function MotionChart({ reading, demo = false }: { reading: Vector3 | null; demo?: boolean }) {
  const { colors: c } = useZendaTheme();
  const [history, setHistory] = useState<Vector3[]>([]);
  const [width, setWidth] = useState(280);
  const [previous, setPrevious] = useState<Vector3 | null>(null);
  if (reading !== previous) {
    setPrevious(reading);
    if (reading) setHistory(h => [...h.slice(-39), reading]);
  }
  const h = 120;
  const y = (value: number) => h / 2 - Math.max(-2, Math.min(2, value)) * h / 4;
  return <View>
    <View style={s.values}>{axes.map(a => <View key={a.key} style={[s.axisValue, { backgroundColor: c.bg }]}><View style={s.legend}><View style={[s.dot, { backgroundColor: a.color }]} /><Text style={{ color: c.muted, fontSize: 11 }}>Eje {a.key.toUpperCase()}</Text></View><Text style={[s.number, { color: c.ink }]}>{reading ? reading[a.key].toFixed(2) : '—'}<Text style={{ fontSize: 11, color: c.muted }}> g</Text></Text></View>)}</View>
    <View style={{ flexDirection: 'row', gap: 8, marginTop: 22 }}>
      <View style={{ height: h, justifyContent: 'space-between' }}>{['+2g', '0g', '−2g'].map(t => <Text key={t} style={{ color: c.muted, fontSize: 9 }}>{t}</Text>)}</View>
      <View accessible accessibilityLabel="Historial de aceleración X, Y y Z, escala de menos 2 a más 2 g" onLayout={e => setWidth(e.nativeEvent.layout.width)} style={{ flex: 1, height: h, overflow: 'hidden' }}>
        {[0, 1, 2, 3, 4].map(i => <View key={i} style={{ position: 'absolute', top: i * (h - 1) / 4, width: '100%', borderTopWidth: 1, borderStyle: 'dashed', borderColor: c.line }} />)}
        {axes.map(a => history.slice(1).map((point, i) => {
          const x1 = i / 39 * width; const x2 = (i + 1) / 39 * width;
          const y1 = y(history[i][a.key]); const y2 = y(point[a.key]);
          const len = Math.hypot(x2 - x1, y2 - y1);
          return <View key={`${a.key}${i}`} style={{ position: 'absolute', left: (x1 + x2) / 2 - len / 2, top: (y1 + y2) / 2, width: len, height: 2, borderRadius: 1, backgroundColor: a.color, transform: [{ rotate: `${Math.atan2(y2 - y1, x2 - x1)}rad` }] }} />;
        }))}
        {!history.length && <Text style={{ color: c.muted, fontSize: 12, alignSelf: 'center', marginTop: 47 }}>Esperando lecturas del sensor</Text>}
      </View>
    </View>
    <View style={[s.legend, { justifyContent: 'space-between', marginTop: 9, marginLeft: 25 }]}><Text style={{ fontSize: 9, color: c.muted }}>40 muestras más recientes</Text><Text style={{ fontSize: 9, color: c.muted }}>{demo ? 'Simulación' : 'Ahora'}</Text></View>
    <Text style={{ fontSize: 11, color: c.muted, lineHeight: 17, marginTop: 18 }}>Cada color representa un eje del teléfono. Incluye gravedad: en reposo, un eje puede marcar cerca de 1 g.</Text>
  </View>;
}
const s = StyleSheet.create({ values: { flexDirection: 'row', gap: 8 }, axisValue: { flex: 1, padding: 10, borderRadius: 12 }, legend: { flexDirection: 'row', gap: 6, alignItems: 'center' }, dot: { width: 6, height: 6, borderRadius: 3 }, number: { fontSize: 20, fontWeight: '600', marginTop: 7, fontVariant: ['tabular-nums'] }, diagram: { flexDirection: 'row', alignItems: 'center', gap: 12 } });
