import { View } from 'react-native';
import Svg, { Circle, Line, Path, Text as SvgText } from 'react-native-svg';

// Tacómetro semicircular: misma velocidad real (gps.speedMs, ya publicada
// por MQTT y graficada como línea en el dashboard) — otra forma de
// mostrar el mismo dato, no uno nuevo ni inventado.
//
// Color: violeta (slot 7 de la paleta categórica validada), el mismo que
// usa la línea de velocidad en el dashboard — misma métrica, mismo color,
// en ambas pantallas.

const COLORS = {
  track: '#e1e0d9',
  accent: '#4a3aa7',
  ink: '#0b0b0b',
  muted: '#898781',
};

const CX = 100;
const CY = 100;
const R = 80;
const NEEDLE_R = 68;

function pointOnArc(angleDeg: number, radius: number) {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: CX + radius * Math.cos(rad), y: CY - radius * Math.sin(rad) };
}

function arcPath(fromDeg: number, toDeg: number, radius: number): string {
  const start = pointOnArc(fromDeg, radius);
  const end = pointOnArc(toDeg, radius);
  const largeArc = fromDeg - toDeg > 180 ? 1 : 0;
  return `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArc} 1 ${end.x} ${end.y}`;
}

interface SpeedGaugeProps {
  speedKmh: number | null;
  maxKmh?: number;
  label?: string;
}

export default function SpeedGauge({ speedKmh, maxKmh = 20, label }: SpeedGaugeProps) {
  const clamped = Math.min(Math.max(speedKmh ?? 0, 0), maxKmh);
  const valueAngle = 180 - (clamped / maxKmh) * 180;
  const needleEnd = pointOnArc(valueAngle, NEEDLE_R);

  return (
    <View style={{ alignItems: 'center' }}>
      <Svg width="100%" height={150} viewBox="0 0 200 135">
        <Path d={arcPath(180, 0, R)} stroke={COLORS.track} strokeWidth={14} fill="none" strokeLinecap="round" />
        {speedKmh != null && (
          <Path
            d={arcPath(180, valueAngle, R)}
            stroke={COLORS.accent}
            strokeWidth={14}
            fill="none"
            strokeLinecap="round"
          />
        )}
        <SvgText x={20} y={112} fontSize={10} fill={COLORS.muted}>
          0
        </SvgText>
        <SvgText x={168} y={112} fontSize={10} fill={COLORS.muted}>
          {maxKmh}
        </SvgText>

        {speedKmh != null && (
          <Line x1={CX} y1={CY} x2={needleEnd.x} y2={needleEnd.y} stroke={COLORS.ink} strokeWidth={3} strokeLinecap="round" />
        )}
        <Circle cx={CX} cy={CY} r={6} fill={COLORS.ink} />

        <SvgText x={CX} y={105} textAnchor="middle" fontSize={24} fontWeight="bold" fill={COLORS.ink}>
          {speedKmh != null ? speedKmh.toFixed(1) : '—'}
        </SvgText>
        <SvgText x={CX} y={122} textAnchor="middle" fontSize={11} fill={COLORS.muted}>
          {speedKmh != null ? 'km/h' : 'sin dato'}
          {label ? ` · ${label}` : ''}
        </SvgText>
      </Svg>
    </View>
  );
}
