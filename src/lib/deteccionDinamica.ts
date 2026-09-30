/* Detección de eventos de dinámica de marcha en el borde.
 *
 * Todo se calcula a partir de la aceleración dinámica (|a - g_ref|,
 * sin gravedad) descompuesta en vertical y horizontal. No hace falta
 * saber cómo está orientado el teléfono dentro del contenedor: la
 * gravedad da el eje vertical y el resto del vector es el plano
 * horizontal.
 *
 * El problema que queda es separar el plano horizontal en longitudinal
 * (frenado) y lateral (curva), y eso sí necesita saber hacia dónde
 * avanza el tren. La solución aquí no usa la brújula (el magnetómetro
 * dentro de un contenedor metálico es poco fiable): se aprende el eje
 * de avance observando en qué dirección apunta la aceleración
 * horizontal cuando el GPS confirma que el vehículo está acelerando o
 * frenando. Mientras no se haya aprendido, los eventos que dependen de
 * esa distinción no se emiten.
 *
 * Todos los umbrales son configurables desde el dashboard con
 * `set_thresholds`.
 */

import { escalar, norma, normalizar, restar, type Vector3 } from './dinamica';

// --- Umbrales por defecto ---------------------------------------------
// Valores de partida basados en dinámica ferroviaria de carga; hay que
// ajustarlos con recorridos reales (ver docs del proyecto).

/** Frenado de servicio: desaceleración normal de operación. */
export const HARD_BRAKE_G = 0.15;
/** Frenado de emergencia: por encima de esto la carga se desplaza. */
export const EMERGENCY_BRAKE_G = 0.25;
/** Aceleración lateral cómoda en curva. Por encima, la carga vuelca o
 *  se recorre. */
export const CURVE_LATERAL_G = 0.12;
/** Golpe: magnitud dinámica total. */
export const DYNAMIC_IMPACT_G = 1.5;
/** Amplitud vertical sostenida que sugiere defecto de vía. */
export const TRACK_IRREGULARITY_G = 0.12;

/** Un evento debe sostenerse este tiempo para no confundir un bache
 *  suelto con un frenado. */
const SUSTAIN_MS = 400;
/** Tras emitir, no se vuelve a emitir el mismo tipo en este tiempo: un
 *  frenado largo es un evento, no cincuenta. */
const COOLDOWN_MS = 5000;
/** Ventana para medir la oscilación vertical de la vía. */
const OSCILACION_VENTANA_MS = 3000;
/** Cruces por cero mínimos en esa ventana para considerarlo oscilación
 *  periódica y no un golpe aislado. */
const OSCILACION_MIN_CRUCES = 6;

export interface Umbrales {
  hardBrakeG: number;
  emergencyBrakeG: number;
  curveLateralG: number;
  dynamicImpactG: number;
  trackIrregularityG: number;
}

export const UMBRALES_POR_DEFECTO: Umbrales = {
  hardBrakeG: HARD_BRAKE_G,
  emergencyBrakeG: EMERGENCY_BRAKE_G,
  curveLateralG: CURVE_LATERAL_G,
  dynamicImpactG: DYNAMIC_IMPACT_G,
  trackIrregularityG: TRACK_IRREGULARITY_G,
};

export type EventoDinamico =
  | { kind: 'hard_brake'; severity: 'info' | 'critical'; value: number; threshold: number }
  | { kind: 'curve_overspeed'; severity: 'warning'; value: number; threshold: number }
  | {
      kind: 'dynamic_impact';
      severity: 'warning' | 'critical';
      value: number;
      threshold: number;
      eje: 'vertical' | 'horizontal';
    }
  | { kind: 'track_irregularity'; severity: 'info'; value: number; threshold: number };

export interface EntradaDeteccion {
  /** Lectura cruda del acelerómetro, en g. */
  accel: Vector3;
  /** Referencia de gravedad medida en reposo. Sin ella no se detecta nada. */
  gravedadRef: Vector3 | null;
  /** Velocidad del GPS en m/s, o null si no hay fix. */
  velocidadMs: number | null;
  ahora: number;
}

/**
 * Detector con estado: hay que llamarlo con cada muestra del
 * acelerómetro (a la frecuencia del bucle de detección, no la de
 * publicación) y devuelve un evento cuando corresponde.
 */
export class DetectorDinamico {
  private umbrales: Umbrales;

  /** Eje de avance en el marco del teléfono, aprendido de la marcha. */
  private ejeAvance: Vector3 | null = null;
  private confianzaEje = 0;

  private sostenidoDesde: Partial<Record<EventoDinamico['kind'], number>> = {};
  private ultimoEmitido: Partial<Record<EventoDinamico['kind'], number>> = {};

  /** Historial de la componente vertical, para medir oscilación. */
  private oscilacion: { t: number; v: number }[] = [];

  private velocidadPrevia: number | null = null;
  private tiempoVelocidadPrevia = 0;

  constructor(umbrales: Umbrales = UMBRALES_POR_DEFECTO) {
    this.umbrales = umbrales;
  }

  setUmbrales(u: Partial<Umbrales>): void {
    this.umbrales = { ...this.umbrales, ...u };
  }

  /** Si ya se aprendió hacia dónde avanza el vehículo. */
  get tieneEjeAvance(): boolean {
    return this.ejeAvance !== null && this.confianzaEje >= 3;
  }

  procesar(e: EntradaDeteccion): EventoDinamico | null {
    if (!e.gravedadRef) return null;

    const dinamica = restar(e.accel, e.gravedadRef);
    const u = normalizar(e.gravedadRef);
    const vertical = escalar(dinamica, u);
    // Componente horizontal como vector, no solo magnitud: hace falta su
    // dirección para separar frenado de curva.
    const horizontalVec: Vector3 = {
      x: dinamica.x - u.x * vertical,
      y: dinamica.y - u.y * vertical,
      z: dinamica.z - u.z * vertical,
    };
    const horizontal = norma(horizontalVec);
    const magnitud = norma(dinamica);

    this.aprenderEjeAvance(e, horizontalVec, horizontal);
    this.registrarOscilacion(e.ahora, vertical);

    // Orden de prioridad: un golpe fuerte importa más que la oscilación
    // de fondo que lo acompaña.
    return (
      this.detectarImpacto(e.ahora, magnitud, vertical, horizontal, e.velocidadMs) ??
      this.detectarFrenadoOCurva(e, horizontalVec, horizontal) ??
      this.detectarIrregularidad(e.ahora, e.velocidadMs)
    );
  }

  /**
   * Aprende el eje longitudinal observando la aceleración horizontal
   * mientras el GPS confirma un cambio real de velocidad. Si el
   * vehículo está frenando y hay aceleración horizontal, esa dirección
   * ES el eje de avance.
   */
  private aprenderEjeAvance(e: EntradaDeteccion, horizontalVec: Vector3, horizontal: number): void {
    if (e.velocidadMs === null) return;

    if (this.velocidadPrevia !== null) {
      const dt = (e.ahora - this.tiempoVelocidadPrevia) / 1000;
      if (dt > 0.5 && dt < 10) {
        const dv = e.velocidadMs - this.velocidadPrevia;
        // Cambio de velocidad claro y aceleración horizontal apreciable:
        // la dirección de esa aceleración es el eje de marcha.
        if (Math.abs(dv) > 1.5 && horizontal > 0.05) {
          const dir = normalizar(horizontalVec);
          // Al frenar la aceleración apunta hacia atrás: se invierte
          // para que el eje quede siempre en el sentido de avance.
          const signo = dv < 0 ? -1 : 1;
          const candidato: Vector3 = {
            x: dir.x * signo,
            y: dir.y * signo,
            z: dir.z * signo,
          };
          if (this.ejeAvance === null) {
            this.ejeAvance = candidato;
            this.confianzaEje = 1;
          } else {
            // Promedio incremental: cada confirmación afina el eje.
            this.ejeAvance = normalizar({
              x: this.ejeAvance.x * 0.8 + candidato.x * 0.2,
              y: this.ejeAvance.y * 0.8 + candidato.y * 0.2,
              z: this.ejeAvance.z * 0.8 + candidato.z * 0.2,
            });
            this.confianzaEje = Math.min(10, this.confianzaEje + 1);
          }
        }
      }
    }

    if (this.velocidadPrevia === null || e.ahora - this.tiempoVelocidadPrevia > 500) {
      this.velocidadPrevia = e.velocidadMs;
      this.tiempoVelocidadPrevia = e.ahora;
    }
  }

  private detectarImpacto(
    ahora: number,
    magnitud: number,
    vertical: number,
    horizontal: number,
    velocidadMs: number | null
  ): EventoDinamico | null {
    if (magnitud < this.umbrales.dynamicImpactG) return null;
    // Parado, un golpe es manipulacion de la carga (carga, descarga,
    // inspeccion), no dinamica de marcha. Sigue siendo informacion util
    // pero baja de severidad: en las pruebas sobre una mesa salian
    // decenas de "criticos" que eran manotazos.
    const enMarcha = (velocidadMs ?? 0) >= 1.5;
    if (!this.pasoCooldown('dynamic_impact', ahora)) return null;

    // Un golpe no se "sostiene": es instantáneo, así que no pasa por el
    // filtro de duración. El eje dominante dice de qué tipo es.
    const eje = Math.abs(vertical) >= horizontal ? 'vertical' : 'horizontal';
    this.ultimoEmitido.dynamic_impact = ahora;
    // El pico del golpe queda en la ventana de oscilacion y se
    // reportaria como amplitud de la via: se descarta la ventana.
    this.oscilacion = [];
    return {
      kind: 'dynamic_impact',
      severity: !enMarcha
        ? 'warning'
        : magnitud > this.umbrales.dynamicImpactG * 2
          ? 'critical'
          : 'warning',
      value: magnitud,
      threshold: this.umbrales.dynamicImpactG,
      eje,
    };
  }

  private detectarFrenadoOCurva(
    e: EntradaDeteccion,
    horizontalVec: Vector3,
    horizontal: number
  ): EventoDinamico | null {
    // Sin eje de avance no se puede distinguir frenar de girar: se
    // prefiere no emitir a emitir algo que podría estar mal.
    if (!this.tieneEjeAvance || this.ejeAvance === null) return null;
    // Parado, cualquier movimiento es manipulación de la carga, no
    // dinámica de marcha.
    if ((e.velocidadMs ?? 0) < 1.5) return null;

    const longitudinal = escalar(horizontalVec, this.ejeAvance);
    // Lo que no es longitudinal, es lateral.
    const lateral = Math.sqrt(Math.max(0, horizontal * horizontal - longitudinal * longitudinal));

    // Frenado: longitudinal negativa (contraria al avance).
    const desaceleracion = -longitudinal;
    if (desaceleracion > this.umbrales.hardBrakeG) {
      if (this.sostenido('hard_brake', e.ahora) && this.pasoCooldown('hard_brake', e.ahora)) {
        this.ultimoEmitido.hard_brake = e.ahora;
        this.sostenidoDesde.hard_brake = undefined;
        const emergencia = desaceleracion > this.umbrales.emergencyBrakeG;
        return {
          kind: 'hard_brake',
          severity: emergencia ? 'critical' : 'info',
          value: desaceleracion,
          threshold: emergencia ? this.umbrales.emergencyBrakeG : this.umbrales.hardBrakeG,
        };
      }
    } else {
      this.sostenidoDesde.hard_brake = undefined;
    }

    if (lateral > this.umbrales.curveLateralG) {
      if (
        this.sostenido('curve_overspeed', e.ahora) &&
        this.pasoCooldown('curve_overspeed', e.ahora)
      ) {
        this.ultimoEmitido.curve_overspeed = e.ahora;
        this.sostenidoDesde.curve_overspeed = undefined;
        return {
          kind: 'curve_overspeed',
          severity: 'warning',
          value: lateral,
          threshold: this.umbrales.curveLateralG,
        };
      }
    } else {
      this.sostenidoDesde.curve_overspeed = undefined;
    }

    return null;
  }

  private registrarOscilacion(ahora: number, vertical: number): void {
    this.oscilacion.push({ t: ahora, v: vertical });
    const limite = ahora - OSCILACION_VENTANA_MS;
    while (this.oscilacion.length > 0 && this.oscilacion[0]!.t < limite) {
      this.oscilacion.shift();
    }
  }

  /**
   * Irregularidad de vía: oscilación vertical periódica y sostenida,
   * distinta de un golpe aislado. Se cuentan los cruces por cero para
   * confirmar que oscila de verdad en vez de ser un solo impulso.
   */
  private detectarIrregularidad(ahora: number, velocidadMs: number | null): EventoDinamico | null {
    // La irregularidad de via solo existe rodando. Parado, la
    // oscilacion es manipulacion de la carga o ruido de la mesa.
    if ((velocidadMs ?? 0) < 1.5) return null;
    if (this.oscilacion.length < 20) return null;
    if (!this.pasoCooldown('track_irregularity', ahora)) return null;

    let cruces = 0;
    let maximo = 0;
    for (let i = 1; i < this.oscilacion.length; i += 1) {
      const a = this.oscilacion[i - 1]!.v;
      const b = this.oscilacion[i]!.v;
      if ((a < 0 && b >= 0) || (a >= 0 && b < 0)) cruces += 1;
      maximo = Math.max(maximo, Math.abs(b));
    }

    if (cruces < OSCILACION_MIN_CRUCES) return null;
    if (maximo < this.umbrales.trackIrregularityG) return null;
    // Una irregularidad de via es rodadura sobre un defecto, no un
    // golpe: amplitudes de ese orden son otra cosa (en las pruebas
    // aparecio una de 1.29 g, que era un manotazo). Se acota a un
    // tercio del umbral de impacto.
    if (maximo >= this.umbrales.dynamicImpactG / 3) return null;

    this.ultimoEmitido.track_irregularity = ahora;
    this.oscilacion = [];
    return {
      kind: 'track_irregularity',
      severity: 'info',
      value: maximo,
      threshold: this.umbrales.trackIrregularityG,
    };
  }

  /** El evento debe mantenerse SUSTAIN_MS para contar como real. */
  private sostenido(kind: EventoDinamico['kind'], ahora: number): boolean {
    const desde = this.sostenidoDesde[kind];
    if (desde === undefined) {
      this.sostenidoDesde[kind] = ahora;
      return false;
    }
    return ahora - desde >= SUSTAIN_MS;
  }

  private pasoCooldown(kind: EventoDinamico['kind'], ahora: number): boolean {
    const ultimo = this.ultimoEmitido[kind];
    return ultimo === undefined || ahora - ultimo >= COOLDOWN_MS;
  }
}
