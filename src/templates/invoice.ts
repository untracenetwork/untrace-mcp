/**
 * Template: Invoice.
 *
 * A plain business document. Every value is a field in <mark>[...]</mark> that the person fills
 * in; no terms of any kind are written in. The same HTML as the Invoice template in Untrace
 * Drive's editor, byte for byte (test/templates.test.ts pins its sha256).
 */

export const INVOICE_HTML = `<h1>Invoice</h1>
<table>
<tbody>
<tr><td><strong>Invoice number</strong></td><td><mark>[Invoice number]</mark></td></tr>
<tr><td><strong>Issue date</strong></td><td><mark>[Issue date]</mark></td></tr>
<tr><td><strong>Due date</strong></td><td><mark>[Due date]</mark></td></tr>
</tbody>
</table>
<h2>From</h2>
<p><strong><mark>[Your business name]</mark></strong></p>
<p><mark>[Street address]</mark></p>
<p><mark>[City, postal code, country]</mark></p>
<p>Email: <mark>[Email]</mark></p>
<p>Phone: <mark>[Phone]</mark></p>
<p>Tax ID: <mark>[Tax ID]</mark></p>
<h2>Bill to</h2>
<p><strong><mark>[Client name]</mark></strong></p>
<p><mark>[Client company]</mark></p>
<p><mark>[Client street address]</mark></p>
<p><mark>[Client city, postal code, country]</mark></p>
<p>Email: <mark>[Client email]</mark></p>
<h2>Items</h2>
<table>
<thead><tr><th>Description</th><th>Qty</th><th>Unit price</th><th>Amount</th></tr></thead>
<tbody>
<tr><td><mark>[Item 1 description]</mark></td><td><mark>[Qty]</mark></td><td><mark>[Unit price]</mark></td><td><mark>[Amount]</mark></td></tr>
<tr><td><mark>[Item 2 description]</mark></td><td><mark>[Qty]</mark></td><td><mark>[Unit price]</mark></td><td><mark>[Amount]</mark></td></tr>
<tr><td><mark>[Item 3 description]</mark></td><td><mark>[Qty]</mark></td><td><mark>[Unit price]</mark></td><td><mark>[Amount]</mark></td></tr>
<tr><td><strong>Subtotal</strong></td><td></td><td></td><td><mark>[Subtotal]</mark></td></tr>
<tr><td><strong>Tax</strong> (<mark>[Tax rate]</mark>)</td><td></td><td></td><td><mark>[Tax amount]</mark></td></tr>
<tr><td><strong>Total due</strong></td><td></td><td></td><td><strong><mark>[Total]</mark></strong></td></tr>
</tbody>
</table>
<h2>Payment details</h2>
<p>Payment terms: <mark>[Payment terms]</mark></p>
<p>Bank name: <mark>[Bank name]</mark></p>
<p>Account name: <mark>[Account name]</mark></p>
<p>Account number or IBAN: <mark>[Account number or IBAN]</mark></p>
<p>SWIFT or BIC: <mark>[SWIFT or BIC]</mark></p>
<p>Reference: <mark>[Invoice number]</mark></p>
<h2>Notes</h2>
<p><mark>[Notes]</mark></p>`
