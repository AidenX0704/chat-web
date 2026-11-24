import { create } from 'zustand'

export type PreviewTarget = {
  /** 已保存附件的本地/服务端文件 ID */
  id?: string
  /** 草稿态直接持有的本地 File 对象 */
  file?: File
  name: string
  size: number
  mimeType?: string
  /** 已由后端结构化解析入库的表格 ID（大表直接走后端分页预览，不卡浏览器） */
  spreadsheetId?: string
}

export const useFilePreview = create<{ target: PreviewTarget | null }>(() => ({
  target: null,
}))

export const openFilePreview = (target: PreviewTarget) => {
  useFilePreview.setState({ target })
}

export const closeFilePreview = () => {
  if (useFilePreview.getState().target !== null) {
    useFilePreview.setState({ target: null })
  }
}
