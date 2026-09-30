import { createContext, useContext, useState, type ReactNode } from 'react';

const light = { bg: '#F5F3EE', card: '#FFFFFF', ink: '#282A2A', muted: '#73736E', line: '#E9E6DF', accent: '#782D40', soft: '#F5E9ED', gold: '#AE874A', green: '#247967', tint: '#EAF4EF', dark: false };
const dark = { bg: '#151A1A', card: '#202727', ink: '#F6F3EC', muted: '#AFB7B3', line: '#35403D', accent: '#E5A4B6', soft: '#3D2931', gold: '#D4B576', green: '#8AD0B6', tint: '#263D35', dark: true };
const Theme = createContext({ colors: light, toggle: () => {} });
export function ZendaThemeProvider({ children }: { children: ReactNode }) {
  const [isDark, setDark] = useState(false);
  return <Theme.Provider value={{ colors: isDark ? dark : light, toggle: () => setDark(v => !v) }}>{children}</Theme.Provider>;
}
export const useZendaTheme = () => useContext(Theme);
