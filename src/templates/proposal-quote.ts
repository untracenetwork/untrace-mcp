/**
 * Template: Proposal / quote.
 *
 * A plain business document. Every value is a field in <mark>[...]</mark> that the person fills
 * in; no terms of any kind are written in. The same HTML as the Proposal / quote template in Untrace
 * Drive's editor, byte for byte (test/templates.test.ts pins its sha256).
 */

export const PROPOSAL_QUOTE_HTML = `<h1>Proposal</h1>
<p><strong><mark>[Project name]</mark></strong></p>
<table>
<tbody>
<tr><td><strong>Client</strong></td><td><mark>[Client name]</mark>, <mark>[Client company]</mark></td></tr>
<tr><td><strong>Prepared by</strong></td><td><mark>[Your name]</mark>, <mark>[Your business name]</mark></td></tr>
<tr><td><strong>Date</strong></td><td><mark>[Date]</mark></td></tr>
<tr><td><strong>Valid until</strong></td><td><mark>[Valid until]</mark></td></tr>
</tbody>
</table>
<h2>Summary</h2>
<p><mark>[Summary: what the client needs and what you propose, in two or three sentences]</mark></p>
<h2>Scope</h2>
<ul>
<li><mark>[Scope item 1]</mark></li>
<li><mark>[Scope item 2]</mark></li>
<li><mark>[Scope item 3]</mark></li>
</ul>
<h2>Deliverables</h2>
<ul>
<li><mark>[Deliverable 1]</mark></li>
<li><mark>[Deliverable 2]</mark></li>
<li><mark>[Deliverable 3]</mark></li>
</ul>
<h2>Timeline</h2>
<table>
<thead><tr><th>Phase</th><th>What happens</th><th>Start</th><th>End</th></tr></thead>
<tbody>
<tr><td><mark>[Phase 1]</mark></td><td><mark>[Phase 1 activities]</mark></td><td><mark>[Start date]</mark></td><td><mark>[End date]</mark></td></tr>
<tr><td><mark>[Phase 2]</mark></td><td><mark>[Phase 2 activities]</mark></td><td><mark>[Start date]</mark></td><td><mark>[End date]</mark></td></tr>
<tr><td><mark>[Phase 3]</mark></td><td><mark>[Phase 3 activities]</mark></td><td><mark>[Start date]</mark></td><td><mark>[End date]</mark></td></tr>
</tbody>
</table>
<h2>Price</h2>
<table>
<thead><tr><th>Item</th><th>Qty</th><th>Unit price</th><th>Amount</th></tr></thead>
<tbody>
<tr><td><mark>[Item 1]</mark></td><td><mark>[Qty]</mark></td><td><mark>[Unit price]</mark></td><td><mark>[Amount]</mark></td></tr>
<tr><td><mark>[Item 2]</mark></td><td><mark>[Qty]</mark></td><td><mark>[Unit price]</mark></td><td><mark>[Amount]</mark></td></tr>
<tr><td><mark>[Item 3]</mark></td><td><mark>[Qty]</mark></td><td><mark>[Unit price]</mark></td><td><mark>[Amount]</mark></td></tr>
<tr><td><strong>Total</strong></td><td></td><td></td><td><strong><mark>[Total]</mark></strong></td></tr>
</tbody>
</table>
<h2>Payment terms</h2>
<p><mark>[Payment terms]</mark></p>
<h2>Acceptance</h2>
<p>To accept this proposal, sign below and return a copy to <mark>[Your name]</mark>.</p>
<table>
<tbody>
<tr><td><strong>Name</strong></td><td><mark>[Client name]</mark></td></tr>
<tr><td><strong>Signature</strong></td><td></td></tr>
<tr><td><strong>Date</strong></td><td><mark>[Date signed]</mark></td></tr>
</tbody>
</table>`
