import { create } from 'zustand'

interface User {
  username: string
  role: string
}

interface AuthState {
  isAuthenticated: boolean
  user: User | null
  credentialsRequired: boolean
  setAuth: (user: User) => void
  logout: () => void
  checkAuth: () => Promise<void>
}

const API_BASE = '/api'

const fetchWithCredentials = async (url: string, credentialsRequired: boolean, options?: RequestInit) => {
  if (credentialsRequired) {
    return fetch(url, { ...options, credentials: 'include' })
  }
  return fetch(url, options)
}

export const useAuthStore = create<AuthState>((set) => ({
  isAuthenticated: false,
  user: null,
  credentialsRequired: true,
  setAuth: (user) => set({ isAuthenticated: true, user }),
  logout: async () => {
    const state = useAuthStore.getState()
    try {
      await fetchWithCredentials(`${API_BASE}/auth/logout`, state.credentialsRequired, { method: 'POST' })
    } catch (e) {
      console.error('Logout error:', e)
    }
    set({ isAuthenticated: false, user: null })
  },
  checkAuth: async () => {
    try {
      const configRes = await fetch(`${API_BASE}/auth/config`)
      const configData = await configRes.json()
      const credentialsRequired = configData.success && configData.data?.credentials_required
      
      if (!credentialsRequired) {
        set({ isAuthenticated: true, credentialsRequired: false, user: { username: 'guest', role: 'viewer' } })
        return
      }
      
      set({ credentialsRequired: true })

      const res = await fetchWithCredentials(`${API_BASE}/auth/status`, true)
      const data = await res.json()
      if (data.success && data.data?.authenticated) {
        set({ isAuthenticated: true, user: data.data.user })
      } else {
        set({ isAuthenticated: false, user: null })
      }
    } catch {
      set({ isAuthenticated: false, user: null, credentialsRequired: true })
    }
  },
}))