import clsx from 'clsx'
import { useCallback, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useAnchoredPosition, useDismiss } from './anchored.js'
import styles from './Menu.module.css'

export type MenuOption = {
  key: string
  label: string
  icon: ReactNode
  danger?: boolean
  onSelect: () => void
}

/**
 * 点击触发，向下展开；点外部或 Esc 关闭。
 * onOpenChange 让触发元素所在的容器知道菜单开着：例如悬停才显示「更多」按钮的列表项，
 * 需要在菜单打开期间保持按钮可见，否则触发元素被隐藏后浮层会失去锚点。
 */
export const Menu = ({
  options,
  children,
  onOpenChange,
}: {
  options: MenuOption[]
  children: (props: { open: boolean; toggle: () => void }) => ReactNode
  onOpenChange?: (open: boolean) => void
}) => {
  const [open, setOpen] = useState(false)
  const change = useCallback(
    (next: boolean) => {
      setOpen(next)
      onOpenChange?.(next)
    },
    [onOpenChange]
  )
  const close = () => change(false)
  // 左侧对齐并再左移 5px，让菜单文字与触发元素图标对齐
  const { anchorRef, floatingRef, position } = useAnchoredPosition<HTMLSpanElement, HTMLDivElement>(
    open,
    { align: 'start', alignOffset: -5, offset: 4 }
  )
  useDismiss(open, [anchorRef, floatingRef], close)

  return (
    <>
      <span ref={anchorRef} className={styles.anchor}>
        {children({ open, toggle: () => change(!open) })}
      </span>
      {open
        ? createPortal(
            <div
              ref={floatingRef}
              className={styles.menu}
              /* 还没量到位置时先藏起来：直接按 0 坐标绘制会闪一下左上角 */
              style={position ?? { top: 0, left: 0, visibility: 'hidden' }}
              role="menu"
            >
              {options.map((option) => (
                <div
                  key={option.key}
                  role="menuitem"
                  className={clsx(styles.option, option.danger && styles.danger)}
                  onClick={() => {
                    change(false)
                    option.onSelect()
                  }}
                >
                  <span className={styles.icon}>{option.icon}</span>
                  {option.label}
                </div>
              ))}
            </div>,
            document.body
          )
        : null}
    </>
  )
}
