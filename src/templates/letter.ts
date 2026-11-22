/**
 * Template: Letter.
 *
 * A plain business document. Every value is a field in <mark>[...]</mark> that the person fills
 * in; no terms of any kind are written in. The same HTML as the Letter template in Untrace
 * Drive's editor, byte for byte (test/templates.test.ts pins its sha256).
 */

export const LETTER_HTML = `<h1><mark>[Your name or business name]</mark></h1>
<p><mark>[Street address]</mark><br><mark>[City, postal code, country]</mark><br><mark>[Email]</mark> | <mark>[Phone]</mark></p>
<p><mark>[Date]</mark></p>
<p><strong><mark>[Recipient name]</mark></strong><br><mark>[Recipient title]</mark><br><mark>[Recipient company]</mark><br><mark>[Recipient street address]</mark><br><mark>[Recipient city, postal code, country]</mark></p>
<p><strong>Subject: <mark>[Subject]</mark></strong></p>
<p>Dear <mark>[Recipient name]</mark>,</p>
<p><mark>[First paragraph: why you are writing]</mark></p>
<p><mark>[Second paragraph: the details]</mark></p>
<p><mark>[Third paragraph: what you ask for or the next step]</mark></p>
<p><mark>[Closing, such as Kind regards]</mark>,</p>
<p><br></p>
<p><strong><mark>[Your name]</mark></strong><br><mark>[Your title]</mark></p>`
