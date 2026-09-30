import { useEffect, useState } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import type { Vector3 } from '@/src/lib/dinamica';
import { useZendaTheme } from '@/src/theme/ZendaTheme';

const axes = [
  { key: 'x', color: '#BA6378', description: 'Ancho del teléfono' },
  { key: 'y', color: '#B9904B', description: 'Largo del teléfono' },
  { key: 'z', color: '#419C97', description: 'Perpendicular a la pantalla' },
] as const;

function AxisBar({ axis, reading }: { axis: typeof axes[number]; reading: Vector3 | null }) {
  const { colors: c } = useZendaTheme();
  const raw = reading?.[axis.key];
  const value = raw != null && Number.isFinite(raw) ? raw : null;
  const bounded = Math.max(-2, Math.min(2, value ?? 0));
  const [position] = useState(() => new Animated.Value(bounded));
  useEffect(() => {
    // Only interpolate between received samples. No autonomous or random motion.
    const animation = Animated.timing(position, { toValue: bounded, duration: 100, useNativeDriver: false });
    animation.start();
    return () => animation.stop();
  }, [bounded, position]);
  const left = position.interpolate({ inputRange: [-2, 0, 2], outputRange: ['0%', '50%', '50%'] });
  const width = position.interpolate({ inputRange: [-2, 0, 2], outputRange: ['50%', '0%', '50%'] });
  const formatted = value == null ? 'Sin lectura' : `${value >= 0 ? '+' : ''}${value.toFixed(3)} g`;
  return <View accessible accessibilityLabel={`Eje ${axis.key.toUpperCase()}: ${formatted}`} style={s.row}>
    <View style={s.heading}><Text style={[s.letter, { color: axis.color }]}>{axis.key.toUpperCase()}</Text><Text style={[s.description, { color: c.muted }]}>{axis.description}</Text><Text style={[s.value, { color: c.ink }]}>{formatted}</Text></View>
    <View testID={`axis-${axis.key}-track`} style={[s.track, { backgroundColor: c.bg, borderColor: c.line }]}>
      {value != null && <Animated.View testID={`axis-${axis.key}-bar`} style={[s.bar, { backgroundColor: axis.color, left, width }]} />}
      <View style={[s.zero, { backgroundColor: c.muted }]} />
    </View>
    {value != null && Math.abs(value) > 2 && <Text style={{ color: c.accent, fontSize: 11, marginTop: 5 }}>Fuera de escala: el valor numérico conserva la lectura completa.</Text>}
  </View>;
}
export default function AxisMeters({ reading, demo = false }: { reading: Vector3 | null; demo?: boolean }) {
  const { colors: c } = useZendaTheme();
  return <View>
    <View style={s.scale}>{['−2 g', '0', '+2 g'].map(t => <Text key={t} style={{ color: c.muted, fontSize: 11 }}>{t}</Text>)}</View>
    {axes.map(axis => <AxisBar key={axis.key} axis={axis} reading={reading} />)}
    <Text style={[s.note, { color: c.ink }]}>Magnitud total |g|: {reading && [reading.x, reading.y, reading.z].every(Number.isFinite) ? `${Math.hypot(reading.x, reading.y, reading.z).toFixed(3)} g` : 'Sin lectura'}</Text>
    <Text style={[s.note, { color: c.muted }]}>{demo ? 'Lecturas simuladas' : 'Lecturas del acelerómetro'} · La barra crece desde cero hacia el signo de cada lectura. Misma escala para los tres ejes.</Text>
    <Text style={[s.note, { color: c.muted }]}>Incluye gravedad: un teléfono en reposo puede marcar cerca de 1 g en un eje. Sin lecturas, las barras quedan vacías.</Text>
  </View>;
}
const s = StyleSheet.create({ scale: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 5 }, row: { marginVertical: 10 }, heading: { flexDirection: 'row', alignItems: 'center', gap: 9, marginBottom: 9, flexWrap: 'wrap' }, letter: { fontWeight: '800', fontSize: 18 }, description: { flex: 1, minWidth: 90, fontSize: 11 }, value: { fontWeight: '600', fontVariant: ['tabular-nums'], fontSize: 14 }, track: { height: 24, borderWidth: 1, borderRadius: 6, overflow: 'hidden' }, bar: { position: 'absolute', height: '100%' }, zero: { position: 'absolute', left: '50%', width: 1, height: '100%' }, note: { marginTop: 12, fontSize: 11, lineHeight: 18 } });
