/* Sesion del operador: token + usuario, guardados cifrados en el
 * celular (Keystore/Keychain via expo-secure-store) — mismo patron que
 * la config del nodo en NodoScreen.tsx (NODE_CONFIG_KEY), para no pedir
 * login en cada arranque de la app.
 */

import { useCallback, useEffect, useState } from 'react';
import * as SecureStore from 'expo-secure-store';

import { api, DEFAULT_API_URL, type AuthUser } from './api';

const SESSION_KEY = 'sitciit.operatorSession';

export interface StoredSession {
  apiUrl: string;
  token: string;
  user: AuthUser;
}

export function useSession() {
  const [session, setSession] = useState<StoredSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [apiUrl, setApiUrl] = useState(DEFAULT_API_URL);

  useEffect(() => {
    (async () => {
      const raw = await SecureStore.getItemAsync(SESSION_KEY);
      if (raw) {
        const s: StoredSession = JSON.parse(raw);
        setSession(s);
        setApiUrl(s.apiUrl);
      }
      setLoading(false);
    })();
  }, []);

  const login = useCallback(async (url: string, email: string, password: string) => {
    const result = await api.login(url, email, password);
    const s: StoredSession = { apiUrl: url, token: result.token, user: result.user };
    await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(s));
    setSession(s);
    setApiUrl(url);
    return s;
  }, []);

  const logout = useCallback(async () => {
    await SecureStore.deleteItemAsync(SESSION_KEY);
    setSession(null);
  }, []);

  return { session, loading, apiUrl, setApiUrl, login, logout };
}
