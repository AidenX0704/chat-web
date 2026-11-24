declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}

declare module '*.css' {}

declare module '*.png' {
  const src: string
  export default src
}

/** 公开 API 的地址，见 rspack.config.ts 的 createConfig */
declare const __API_ORIGIN__: string

/** 后端服务地址；'/' 或 'same-origin' 表示同源代理，为空或 'none' 表示纯静态直连 __API_ORIGIN__ */
declare const __BACKEND_ORIGIN__: string

/** Prism 语言包通过副作用注册到全局 Prism */
declare module 'prismjs/components/*' {}

/** KaTeX 化学公式扩展通过副作用注册到 KaTeX */
declare module 'katex/contrib/mhchem' {}
