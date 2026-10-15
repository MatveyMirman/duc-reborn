import { create } from 'zustand'

export interface FileNode {
  path: string
  name: string
  size: number
  is_dir: boolean
  children?: FileNode[]
  file_count?: number
  modified?: number
  /** Client-side marker for the synthetic "Free space" visualization node. */
  is_free_space?: boolean
}

export interface ScanResult {
  id: string
  path: string
  roots?: string[]
  disks?: string[]
  same_filesystem?: boolean
  total_size: number
  total_files: number
  total_dirs: number
  scan_time_ms: number
  created_at: string
}

interface ScanStatus {
  id: string
  path: string
  status: 'running' | 'completed' | 'failed'
  progress_files: number
  progress_dirs: number
  progress_size: number
  current_path: string | null
  total_files: number | null
  total_dirs: number | null
  error_message: string | null
}

interface HistoryItem {
  id: string
  path: string
  disks: string
  status: 'running' | 'completed' | 'failed'
  total_size: number
  total_files: number
  total_dirs: number
  progress_files?: number
  progress_dirs?: number
  progress_size?: number
  current_path?: string
  scan_time_ms: number
  error_message?: string
  created_at: string
}

export interface BreadcrumbItem {
  name: string
  path?: string
}

export interface DiskInfo {
  device: string
  fstype: string
  mountpoints: string[]
  total_size: number
  used: number
  available: number
  model: string | null
  label: string | null
}

function buildBreadcrumb(scanPath: string, nodePath?: string): BreadcrumbItem[] {
  const root = scanPath || '/'
  const items: BreadcrumbItem[] = [{ name: root, path: undefined }]

  if (!nodePath || nodePath === root) {
    return items
  }

  const normalizedScan = root === '/' ? '' : root.replace(/\/+$/, '')
  const normalizedNode = nodePath.replace(/\/+$/, '')

  if (!normalizedNode.startsWith(normalizedScan)) {
    return items
  }

  const relative = normalizedNode.slice(normalizedScan.length).replace(/^\/+/, '')
  if (!relative) return items

  const parts = relative.split('/').filter(Boolean)

  let currentPath = normalizedScan
  for (const part of parts) {
    currentPath = currentPath === '' ? '/' + part : currentPath + '/' + part
    items.push({ name: part, path: currentPath })
  }

  return items
}

function normalizeForPrefix(path: string): string {
  if (!path || path === '/') return '/'
  return path.replace(/\/+$/, '') || '/'
}

/**
 * Find the disk whose filesystem contains `scanPath`, by longest mountpoint
 * prefix match. Used to source live free-space numbers for visualizations.
 */
export function findDiskForScanPath(
  disks: DiskInfo[],
  scanPath?: string,
): DiskInfo | null {
  if (!scanPath) return null
  const target = normalizeForPrefix(scanPath)
  let best: DiskInfo | null = null
  let bestLen = -1
  for (const disk of disks) {
    for (const rawMp of disk.mountpoints) {
      const mp = normalizeForPrefix(rawMp)
      const isMatch =
        mp === '/' ? target.startsWith('/') : target === mp || target.startsWith(`${mp}/`)
      if (isMatch && mp.length > bestLen) {
        best = disk
        bestLen = mp.length
      }
    }
  }
  return best
}

interface ScanState {
  currentScan: ScanResult | null
  currentTree: FileNode | null
  /** Subtrees already fetched from the API, keyed by absolute path. */
  treeCache: Record<string, FileNode>
  breadcrumb: BreadcrumbItem[]
  treeLoading: boolean
  isScanning: boolean
  scanStatus: ScanStatus | null
  error: string | null
  viewMode: 'list' | 'treemap' | 'pie'
  showFreeSpace: boolean
  history: HistoryItem[]
  activeScanIds: string[]
  disks: DiskInfo[]
  disksLoading: boolean
  setScan: (scan: ScanResult | null) => void
  setScanning: (scanning: boolean) => void
  setError: (error: string | null) => void
  setViewMode: (mode: 'list' | 'treemap' | 'pie') => void
  setShowFreeSpace: (show: boolean) => void
  setBreadcrumb: (breadcrumb: BreadcrumbItem[]) => void
  startScan: (path: string, maxDepth?: number, disks?: string[]) => Promise<void>
  loadDisks: () => Promise<void>
  loadScan: (id: string) => Promise<void>
  loadHistory: () => Promise<void>
  deleteScan: (id: string) => Promise<void>
  pollRunningScans: () => Promise<void>
  pollScanStatus: (scanId: string) => Promise<boolean>
  fetchTree: (scanId: string, path?: string, depth?: number, maxChildren?: number) => Promise<void>
  drillDown: (scanId: string, path: string) => Promise<void>
  navigateBreadcrumb: (scanId: string, index: number) => Promise<void>
}

const API_BASE = '/api'

export const useScanStore = create<ScanState>((set, get) => ({
  currentScan: null,
  currentTree: null,
  treeCache: {},
  breadcrumb: [],
  treeLoading: false,
  isScanning: false,
  scanStatus: null,
  error: null,
  viewMode: 'list',
  showFreeSpace: false,
  history: [],
  activeScanIds: [],
  disks: [],
  disksLoading: false,
  setScan: (scan) => set({ currentScan: scan }),
  setScanning: (scanning) => set({ isScanning: scanning }),
  setError: (error) => set({ error }),
  setViewMode: (mode) => set({ viewMode: mode }),
  setShowFreeSpace: (show) => set({ showFreeSpace: show }),
  setBreadcrumb: (breadcrumb) => set({ breadcrumb }),
  loadDisks: async () => {
    set({ disksLoading: true })
    try {
      const res = await fetch(`${API_BASE}/disks`, { credentials: 'include' })
      const data = await res.json()
      if (data.success) {
        set({ disks: data.data as DiskInfo[], disksLoading: false })
      } else {
        set({ disksLoading: false })
      }
    } catch {
      console.error('Failed to load disks')
      set({ disksLoading: false })
    }
  },
  startScan: async (path, maxDepth, disks) => {
    set({ isScanning: true, error: null, scanStatus: null, currentScan: null, currentTree: null, treeCache: {}, breadcrumb: [] })
    try {
      const body: Record<string, unknown> = {
        path,
        max_depth: maxDepth,
        follow_symlinks: false,
        same_filesystem: true,
      }
      if (disks && disks.length > 0) {
        body.disks = disks
      }
      const res = await fetch(`${API_BASE}/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (data.success) {
        const scanId = data.data.id
        const effectivePath = data.data.path || path
        set({
          currentScan: data.data,
          scanStatus: {
            id: scanId,
            path: effectivePath,
            status: 'running',
            progress_files: 0,
            progress_dirs: 0,
            progress_size: 0,
            current_path: null,
            total_files: null,
            total_dirs: null,
            error_message: null,
          },
        })
        get().loadHistory()
      } else {
        set({ error: data.error || 'Scan failed', isScanning: false })
      }
    } catch (e) {
      set({ error: 'Failed to start scan', isScanning: false })
    }
  },
  pollScanStatus: async (scanId) => {
    try {
      const res = await fetch(`${API_BASE}/scan/${scanId}/status`, { credentials: 'include' })
      const data = await res.json()
      if (data.success) {
        const status: ScanStatus = data.data
        set({ scanStatus: status })

        if (status.status === 'completed') {
          const scanRes = await fetch(`${API_BASE}/scan/${scanId}`, { credentials: 'include' })
          const scanData = await scanRes.json()
          if (scanData.success) {
            set({ currentScan: scanData.data, isScanning: false })
          } else {
            set({ isScanning: false })
          }
          get().loadHistory()
          return true
        } else if (status.status === 'failed') {
          set({ error: status.error_message || 'Scan failed', isScanning: false })
          get().loadHistory()
          return true
        }
      }
      return false
    } catch (e) {
      return false
    }
  },
  loadScan: async (id) => {
    set({ isScanning: true, error: null, currentScan: null, currentTree: null, treeCache: {}, breadcrumb: [], scanStatus: null })
    try {
      const res = await fetch(`${API_BASE}/scan/${id}`, { credentials: 'include' })
      const data = await res.json()
      if (data.success) {
        set({ currentScan: data.data, isScanning: false })
      } else {
        set({ error: data.error || 'Failed to load scan', isScanning: false })
      }
    } catch (e) {
      set({ error: 'Failed to load scan', isScanning: false })
    }
  },
  loadHistory: async () => {
    try {
      const res = await fetch(`${API_BASE}/history`, { credentials: 'include' })
      const data = await res.json()
      if (data.success) {
        const activeIds = data.data
          .filter((item: HistoryItem) => item.status === 'running')
          .map((item: HistoryItem) => item.id)
        set({ history: data.data, activeScanIds: activeIds })
      }
    } catch (e) {
      console.error('Failed to load history')
    }
  },
  pollRunningScans: async () => {
    const { activeScanIds } = get()
    if (activeScanIds.length === 0) return

    const res = await fetch(`${API_BASE}/history`, { credentials: 'include' })
    const data = await res.json()
    if (data.success) {
      const activeIds = data.data
        .filter((item: HistoryItem) => item.status === 'running')
        .map((item: HistoryItem) => item.id)
      set({ history: data.data, activeScanIds: activeIds })
    }
  },
  deleteScan: async (id) => {
    try {
      const res = await fetch(`${API_BASE}/scan/${id}`, {
        method: 'DELETE',
        credentials: 'include',
      })
      const data = await res.json()
      if (data.success) {
        set((state) => ({
          history: state.history.filter((h) => h.id !== id),
          activeScanIds: state.activeScanIds.filter((a) => a !== id),
          currentScan: state.currentScan?.id === id ? null : state.currentScan,
          currentTree: state.currentScan?.id === id ? null : state.currentTree,
          treeCache: state.currentScan?.id === id ? {} : state.treeCache,
          breadcrumb: state.currentScan?.id === id ? [] : state.breadcrumb,
          scanStatus: state.currentScan?.id === id ? null : state.scanStatus,
        }))
      } else {
        set({ error: data.error || 'Failed to delete scan' })
      }
    } catch (e) {
      set({ error: 'Failed to delete scan' })
    }
  },
  fetchTree: async (scanId, path, depth = 2, maxChildren = 100) => {
    set({ treeLoading: true, error: null })
    try {
      const params = new URLSearchParams()
      params.set('depth', String(depth))
      params.set('max_children', String(maxChildren))

      const url = path
        ? `${API_BASE}/scan/${scanId}/node?path=${encodeURIComponent(path)}&${params}`
        : `${API_BASE}/scan/${scanId}/tree?${params}`

      const res = await fetch(url, { credentials: 'include' })
      if (!res.ok) {
        set({
          error: res.status === 524 || res.status === 504
            ? 'Tree load timed out — try a narrower path'
            : `Failed to load tree (${res.status})`,
          treeLoading: false,
        })
        return
      }
      const data = await res.json()
      if (data.success) {
        const node = data.data as FileNode
        set((state) => ({
          currentTree: node,
          treeCache: { ...state.treeCache, [node.path]: node },
          treeLoading: false,
        }))
      } else {
        set({ error: data.error || 'Failed to load tree', treeLoading: false })
      }
    } catch (e) {
      set({ error: 'Failed to load tree', treeLoading: false })
    }
  },
  drillDown: async (scanId, path) => {
    const scan = get().currentScan
    if (!scan) return
    set({ breadcrumb: buildBreadcrumb(scan.path, path) })
    const cached = get().treeCache[path]
    if (cached && cached.children && cached.children.length > 0) {
      set({ currentTree: cached, error: null, treeLoading: false })
      return
    }
    await get().fetchTree(scanId, path)
  },
  navigateBreadcrumb: async (scanId, index) => {
    const { breadcrumb, treeCache } = get()
    const newBreadcrumb = breadcrumb.slice(0, index + 1)
    const item = newBreadcrumb[newBreadcrumb.length - 1]
    set({ breadcrumb: newBreadcrumb })
    const scan = get().currentScan
    const targetPath = item.path ?? scan?.path
    const cached = targetPath ? treeCache[targetPath] : undefined
    if (cached && cached.children && cached.children.length > 0) {
      set({ currentTree: cached, error: null, treeLoading: false })
      return
    }
    await get().fetchTree(scanId, item.path)
  },
}))
