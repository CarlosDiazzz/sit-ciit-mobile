/* Cálculos de dinámica sobre las lecturas crudas del acelerómetro y el
 * giroscopio.
 *
 * Por qué existe este módulo: expo-sensors entrega la aceleración
 * *cruda*, con la gravedad incluida — no expone los sensores fusionados
 * de Android (TYPE_GRAVITY, TYPE_LINEAR_ACCELERATION). Así que la
 * separación entre gravedad y movimiento hay que hacerla aquí.
 *
 * Todo se calcula respecto a una referencia de gravedad medida en
 * reposo, no respecto a una orientación fija del teléfono: el celular
 * puede ir en cualquier posición dentro del contenedor.
 */

export interface Vector3 {
  x: number;
  y: number;
  z: number;
}

export function norma(v: Vector3): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

export function restar(a: Vector3, b: Vector3): Vector3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function escalar(a: Vector3, b: Vector3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function normalizar(v: Vector3): Vector3 {
  const n = norma(v);
  if (n === 0) return { x: 0, y: 0, z: 0 };
  return { x: v.x / n, y: v.y / n, z: v.z / n };
}

/**
 * Magnitud dinámica: cuánta aceleración hay *además* de la gravedad.
 *
 * Antes se usaba la magnitud cruda √(x²+y²+z²), que en reposo vale 1 g:
 * un golpe real de 1.5 g se medía como 2.5 g y el umbral quedaba
 * desplazado en exactamente 1 g. Restando el vector de referencia queda
 * 0 en reposo y mide el golpe de verdad.
 */
export function magnitudDinamica(lectura: Vector3, gravedadRef: Vector3 | null): number {
  if (!gravedadRef) return Math.abs(norma(lectura) - 1);
  return norma(restar(lectura, gravedadRef));
}

/**
 * Descompone la aceleración dinámica en la componente paralela a la
 * gravedad (vertical: vía, juntas, baches) y la perpendicular
 * (horizontal: frenado, curvas, acoplamiento).
 *
 * Es lo que permite distinguir un golpe de vía de un tirón de enganche
 * sin saber cómo está orientado el teléfono: la gravedad da la
 * referencia vertical, y el resto del vector es el plano horizontal.
 */
export function descomponer(
  lectura: Vector3,
  gravedadRef: Vector3
): { vertical: number; horizontal: number } {
  const dinamica = restar(lectura, gravedadRef);
  const u = normalizar(gravedadRef);
  // Proyección sobre la vertical; el signo indica arriba/abajo.
  const vertical = escalar(dinamica, u);
  const magnitud = norma(dinamica);
  // Pitágoras: lo que no es vertical es horizontal. El max(0) evita una
  // raíz de un negativo por error de redondeo.
  const horizontal = Math.sqrt(Math.max(0, magnitud * magnitud - vertical * vertical));
  return { vertical, horizontal };
}

/** Ángulo en grados entre la lectura actual y la referencia vertical. */
export function anguloDesdeReferencia(lectura: Vector3, referencia: Vector3): number {
  const na = norma(lectura);
  const nb = norma(referencia);
  if (na === 0 || nb === 0) return 0;
  // El clamp protege de un |cos| > 1 por redondeo, que daría NaN.
  const cos = Math.min(1, Math.max(-1, escalar(lectura, referencia) / (na * nb)));
  return (Math.acos(cos) * 180) / Math.PI;
}

/**
 * Promedia varias lecturas para calibrar. En reposo, el promedio del
 * acelerómetro es el vector de gravedad; el del giroscopio es su sesgo
 * (un giroscopio parado rara vez marca cero exacto, y ese error se
 * acumula si no se resta).
 */
export function promediar(muestras: Vector3[]): Vector3 | null {
  if (muestras.length === 0) return null;
  const suma = muestras.reduce((acc, m) => ({ x: acc.x + m.x, y: acc.y + m.y, z: acc.z + m.z }), {
    x: 0,
    y: 0,
    z: 0,
  });
  return {
    x: suma.x / muestras.length,
    y: suma.y / muestras.length,
    z: suma.z / muestras.length,
  };
}

/** Media móvil exponencial, para suavizar sin guardar historial. */
export function ema(anterior: number, valor: number, alfa = 0.3): number {
  return anterior * (1 - alfa) + valor * alfa;
}

/**
 * Mide la frecuencia real a la que llegan las lecturas.
 *
 * `setUpdateInterval` es una sugerencia: Android entrega lo que el
 * hardware permite, que en gama baja puede ser bastante más lento de lo
 * pedido. Los cálculos que dependen del tiempo (integrar, longitud de
 * onda) deben usar el intervalo efectivo, no el solicitado.
 */
export class MedidorFrecuencia {
  private ultimo = 0;
  private intervaloMs = 0;
  private muestras = 0;

  registrar(ahora = Date.now()): void {
    if (this.ultimo !== 0) {
      const dt = ahora - this.ultimo;
      // Se ignoran los saltos grandes (app en segundo plano, pausa del SO).
      if (dt > 0 && dt < 1000) {
        this.intervaloMs = this.muestras === 0 ? dt : ema(this.intervaloMs, dt, 0.1);
        this.muestras += 1;
      }
    }
    this.ultimo = ahora;
  }

  /** Intervalo efectivo en ms, o null si aún no hay datos suficientes. */
  get intervalo(): number | null {
    return this.muestras < 5 ? null : this.intervaloMs;
  }

  get hz(): number | null {
    const i = this.intervalo;
    return i === null || i === 0 ? null : 1000 / i;
  }
}
