import { Script } from '../script'

export const gtmNoScript = (gtmId: string) => {
  return `<!-- Google Tag Manager (noscript) -->
    <noscript><iframe src="https://www.googletagmanager.com/ns.html?id=${gtmId}"
    height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>
    <!-- End Google Tag Manager (noscript) -->`
}

export const gtmScript = (gtmId: string) => {
  return `(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':
    new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],
    j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=
    'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
    })(window,document,'script','dataLayer','${gtmId}');`
}

export interface ScriptGtmProps {
  gtmId: string
}

export const ScriptGtm = (props: ScriptGtmProps) => {
  const { gtmId } = props

  return (
    <Script id="gtm" strategy="afterInteractive">
      {gtmScript(gtmId)}
    </Script>
  )
}
