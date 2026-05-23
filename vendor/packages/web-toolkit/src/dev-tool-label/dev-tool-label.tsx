import { Fragment, useState } from 'react'

declare global {
  interface Window {
    _app?: Record<string, any>
    DevToolService?: any
  }
}

const isSSR = typeof window === 'undefined'

/**
 * @description Dev tool label component for displaying the dev label in the bottom right corner of the screen
 *
 * Also see component SemanticVersion
 */
export const DevToolLabel = (props: { release?: string }) => {
  const { release = '' } = props

  const [devLabel] = useState<string>(() => {
    if (isSSR) {
      return ''
    }

    return getDevLabel(release)
  })

  if (!devLabel) {
    return null
  }

  return (
    <Fragment>
      <style>
        {`
          #dev-tool-label-button {
            all: unset;
            box-sizing: border-box;
            position: fixed;
            display: grid;
            place-content: center;
            left: 8px;
            bottom: 320px;
            cursor: pointer;
            border: none;
            border-radius: 20px;
            background: transparent;
            display: inline-flex;
            align-items: center;
            direction: rtl;
            -webkit-tap-highlight-color: transparent;
            color: #fff;
            font-size: 11px;
            font-weight: 500;
            z-index: 1000;
            color: #000;
            padding: 4px 3px 3px 3px;
            background: #fc64b9;
            border: 1px solid #000;
            opacity: 0.9;

            &:hover,
            &:focus,
            &:active {
              outline: none;
            }
          }
          `}
      </style>

      <button type="button" onClick={onClick} id="dev-tool-label-button">
        {devLabel}
      </button>
    </Fragment>
  )
}

const onClick = () => {
  if (window.DevToolService) {
    window.DevToolService.open()
  } else {
    console.error('DevToolService is not defined')
  }
}

const getDevLabel = (branchName: string) => {
  const chunks = branchName.split('/')

  return chunks.at(-1) || ''
}
