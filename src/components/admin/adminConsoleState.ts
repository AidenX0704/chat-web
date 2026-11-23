import { create } from 'zustand'

export type AdminTab = 'policy' | 'visitors' | 'logs'

type AdminConsoleState = {
  open: boolean
  tab: AdminTab
  filterIp: string
}

export const useAdminConsole = create<AdminConsoleState>(() => ({
  open: false,
  tab: 'policy',
  filterIp: '',
}))

export const openAdminConsole = (tab: AdminTab = 'policy', filterIp = '') => {
  useAdminConsole.setState({ open: true, tab, filterIp })
}

export const closeAdminConsole = () => {
  useAdminConsole.setState({ open: false })
}
