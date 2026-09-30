/* Cliente REST minimo hacia sit-ciit-backend, para la pestana Operador.
 *
 * Mismos tres endpoints que ya usa sit-ciit-dashboard con el rol
 * "operator" (login, listar unidades, emitir comandos) — no se agrega
 * nada nuevo del lado del servidor, solo se consume desde el celular.
 */

import type { CmdAction, IssuerRole } from '@/src/contract/contract';

// Ya existia en .env/.env.example sin usarse en ningun lado — mismo
// patron que EXPO_PUBLIC_DEFAULT_MQTT_URL ya usa NodoScreen.tsx.
export const DEFAULT_API_URL =
  process.env.EXPO_PUBLIC_DEFAULT_BACKEND_URL ?? 'http://192.168.1.100:3000';

export type UserRole = IssuerRole | 'admin' | 'cliente' | 'technician' | 'auditor';

export interface AuthUser {
  id: string;
  email: string;
  role: UserRole;
}

export interface LoginResponse {
  token: string;
  user: AuthUser;
}

export interface NodeSummary {
  id: string;
  nodeCode: string;
  role: 'primary' | 'backup';
  isOnline: boolean;
}

export interface UnitSummary {
  id: string;
  unitCode: string;
  label: string | null;
  nodes: NodeSummary[];
}

export interface CommandRecord {
  id: string;
  cmdId: string;
  targetNodeCode: string;
  status: string;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(
  apiUrl: string,
  path: string,
  init?: RequestInit & { token?: string },
): Promise<T> {
  const { token, ...rest } = init ?? {};
  let res: Response;
  try {
    res = await fetch(`${apiUrl}${path}`, {
      ...rest,
      headers: {
        // Solo si hay body: el backend (Fastify) rechaza con 400 una
        // peticion sin body que de todos modos declara
        // Content-Type: application/json.
        ...(rest.body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...rest.headers,
      },
    });
  } catch {
    throw new ApiError(0, 'No se pudo conectar con el backend. Revisa la URL y la red.');
  }

  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ApiError(res.status, body?.message ?? body?.error ?? `Error ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export const api = {
  login: (apiUrl: string, email: string, password: string) =>
    request<LoginResponse>(apiUrl, '/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  listUnits: (apiUrl: string, token: string) =>
    request<UnitSummary[]>(apiUrl, '/units', { token }),

  issueCommand: (
    apiUrl: string,
    token: string,
    targetNodeId: string,
    action: CmdAction,
    params?: Record<string, unknown>,
  ) =>
    request<CommandRecord>(apiUrl, '/commands', {
      method: 'POST',
      token,
      body: JSON.stringify({ targetNodeId, action, params }),
    }),
};
