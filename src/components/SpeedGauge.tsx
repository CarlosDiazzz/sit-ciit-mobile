import { StyleSheet, View } from 'react-native';

import { Text } from '@/components/Themed';
import { useAnimatedNumber } from '@/src/lib/useAnimatedNumber';

// Velocímetro digital: mismo gps.speedMs real que ya se publica por MQTT
// y se grafica en el dashboard, mostrado como número grande (estilo
// tablero digital de auto) en vez de aguja/arco.
//
// El número se anima entre una lectura real y la siguiente en vez de
// saltar de golpe — se siente "en vivo" aunque el GPS solo llegue cada
// varios segundos. No inventa valores intermedios como mediciones, solo
// suaviza cómo se muestra el cambio entre dos reales.

const ACCENT = '#4a3aa7'; // mismo violeta que la línea de velocidad en el dashboard
const MUTED = '#898781';

interface SpeedGaugeProps {
  speedKmh: number | null;
  label?: string;
}

export default function SpeedGauge({ speedKmh, label }: SpeedGaugeProps) {
  const animated = useAnimatedNumber(speedKmh);

  return (
    <View style={styles.container}>
      <Text style={[styles.value, { color: animated != null ? ACCENT : MUTED }]}>
        {animated != null ? animated.toFixed(1) : '—'}
      </Text>
      <Text style={styles.unit}>
        {speedKmh != null ? 'km/h' : 'sin dato'}
        {label ? ` · ${label}` : ''}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { alignItems: 'center', paddingVertical: 8 },
  value: { fontSize: 48, fontWeight: 'bold', fontVariant: ['tabular-nums'] },
  unit: { fontSize: 13, color: MUTED, marginTop: -4 },
});
