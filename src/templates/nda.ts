/**
 * Template: Mutual Non-Disclosure Agreement.
 *
 * Text: Common Paper Mutual Non-Disclosure Agreement, Version 1.0 (Cover Page + Standard Terms),
 * free to use under CC BY 4.0 (creativecommons.org/licenses/by/4.0). Source: the
 * CommonPaper/Mutual-NDA repository, commit 2a3068b6c0ab6015c440f541d5b215bc3ac2f4cb. The clauses
 * are copied word for word; no clause is added, removed or reworded. Formatting changes only:
 * markdown to HTML, links as plain text, and every value a party fills in wrapped in <mark>.
 * The credit line at the end of the cover page and of the standard terms is part of the licence:
 * keep it.
 *
 * The same HTML as the Mutual NDA in Untrace Drive's editor, byte for byte
 * (test/templates.test.ts pins its sha256).
 */

export const NDA_SOURCE = {
  name: "Common Paper Mutual Non-Disclosure Agreement",
  version: "1.0",
  licence: "CC BY 4.0",
  repo: "CommonPaper/Mutual-NDA",
  commit: "2a3068b6c0ab6015c440f541d5b215bc3ac2f4cb",
} as const

export const NDA_HTML = `<h1>Mutual Non-Disclosure Agreement</h1>
<h2>USING THIS MUTUAL NON-DISCLOSURE AGREEMENT</h2>
<p>This Mutual Non-Disclosure Agreement (the “MNDA”) consists of: (1) this Cover Page (“<strong>Cover Page</strong>”) and (2) the Common Paper Mutual NDA Standard Terms Version 1.0 (“<strong>Standard Terms</strong>”) identical to those posted at commonpaper.com/standards/mutual-nda/1.0. Any modifications of the Standard Terms should be made on the Cover Page, which will control over conflicts with the Standard Terms.</p>
<h3>Purpose</h3>
<p><em>How Confidential Information may be used</em></p>
<p><mark>[Evaluating whether to enter into a business relationship with the other party.]</mark></p>
<h3>Effective Date</h3>
<p><mark>[Today’s date]</mark></p>
<h3>MNDA Term</h3>
<p><em>The length of this MNDA</em></p>
<p>☒ Expires <mark>[1 year(s)]</mark> from Effective Date.</p>
<p>☐ Continues until terminated in accordance with the terms of the MNDA.</p>
<h3>Term of Confidentiality</h3>
<p><em>How long Confidential Information is protected</em></p>
<p>☒ <mark>[1 year(s)]</mark> from Effective Date, but in the case of trade secrets until Confidential Information is no longer considered a trade secret under applicable laws.</p>
<p>☐ In perpetuity.</p>
<h3>Governing Law &amp; Jurisdiction</h3>
<p>Governing Law: <mark>[Fill in state]</mark></p>
<p>Jurisdiction: <mark>[Fill in city or county and state, i.e. “courts located in New Castle, DE”]</mark></p>
<h3>MNDA Modifications</h3>
<p><em>List any modifications to the MNDA</em></p>
<p><mark>[None]</mark></p>
<p>By signing this Cover Page, each party agrees to enter into this MNDA as of the Effective Date.</p>
<table>
<thead><tr><th></th><th>PARTY 1</th><th>PARTY 2</th></tr></thead>
<tbody>
<tr><td><strong>Signature</strong></td><td></td><td></td></tr>
<tr><td><strong>Print Name</strong></td><td><mark>[Party 1 print name]</mark></td><td><mark>[Party 2 print name]</mark></td></tr>
<tr><td><strong>Title</strong></td><td><mark>[Party 1 title]</mark></td><td><mark>[Party 2 title]</mark></td></tr>
<tr><td><strong>Company</strong></td><td><mark>[Party 1 company]</mark></td><td><mark>[Party 2 company]</mark></td></tr>
<tr><td><strong>Notice Address</strong> <em>Use either email or postal address</em></td><td><mark>[Party 1 notice address]</mark></td><td><mark>[Party 2 notice address]</mark></td></tr>
<tr><td><strong>Date</strong></td><td><mark>[Party 1 date]</mark></td><td><mark>[Party 2 date]</mark></td></tr>
</tbody>
</table>
<p><small>Common Paper Mutual Non-Disclosure Agreement (Version 1.0) free to use under CC BY 4.0 (creativecommons.org/licenses/by/4.0).</small></p>
<hr>
<h2>Standard Terms</h2>
<ol>
<li><strong>Introduction</strong>. This Mutual Non-Disclosure Agreement (which incorporates these Standard Terms and the Cover Page (defined below)) (“<strong>MNDA</strong>”) allows each party (“<strong>Disclosing Party</strong>”) to disclose or make available information in connection with the Purpose which (1) the Disclosing Party identifies to the receiving party (“<strong>Receiving Party</strong>”) as “confidential”, “proprietary”, or the like or (2) should be reasonably understood as confidential or proprietary due to its nature and the circumstances of its disclosure (“<strong>Confidential Information</strong>”). Each party’s Confidential Information also includes the existence and status of the parties’ discussions and information on the Cover Page. Confidential Information includes technical or business information, product designs or roadmaps, requirements, pricing, security and compliance documentation, technology, inventions and know-how. To use this MNDA, the parties must complete and sign a cover page incorporating these Standard Terms (“<strong>Cover Page</strong>”). Each party is identified on the Cover Page and capitalized terms have the meanings given herein or on the Cover Page.</li>
<li><strong>Use and Protection of Confidential Information</strong>. The Receiving Party shall: (a) use Confidential Information solely for the Purpose; (b) not disclose Confidential Information to third parties without the Disclosing Party’s prior written approval, except that the Receiving Party may disclose Confidential Information to its employees, agents, advisors, contractors and other representatives having a reasonable need to know for the Purpose, provided these representatives are bound by confidentiality obligations no less protective of the Disclosing Party than the applicable terms in this MNDA and the Receiving Party remains responsible for their compliance with this MNDA; and (c) protect Confidential Information using at least the same protections the Receiving Party uses for its own similar information but no less than a reasonable standard of care.</li>
<li><strong>Exceptions</strong>. The Receiving Party’s obligations in this MNDA do not apply to information that it can demonstrate: (a) is or becomes publicly available through no fault of the Receiving Party; (b) it rightfully knew or possessed prior to receipt from the Disclosing Party without confidentiality restrictions; (c) it rightfully obtained from a third party without confidentiality restrictions; or (d) it independently developed without using or referencing the Confidential Information.</li>
<li><strong>Disclosures Required by Law</strong>. The Receiving Party may disclose Confidential Information to the extent required by law, regulation or regulatory authority, subpoena or court order, provided (to the extent legally permitted) it provides the Disclosing Party reasonable advance notice of the required disclosure and reasonably cooperates, at the Disclosing Party’s expense, with the Disclosing Party’s efforts to obtain confidential treatment for the Confidential Information.</li>
<li><strong>Term and Termination</strong>. This MNDA commences on the Effective Date and expires at the end of the MNDA Term. Either party may terminate this MNDA for any or no reason upon written notice to the other party. The Receiving Party’s obligations relating to Confidential Information will survive for the Term of Confidentiality, despite any expiration or termination of this MNDA.</li>
<li><strong>Return or Destruction of Confidential Information</strong>. Upon expiration or termination of this MNDA or upon the Disclosing Party’s earlier request, the Receiving Party will: (a) cease using Confidential Information; (b) promptly after the Disclosing Party’s written request, destroy all Confidential Information in the Receiving Party’s possession or control or return it to the Disclosing Party; and (c) if requested by the Disclosing Party, confirm its compliance with these obligations in writing. As an exception to subsection (b), the Receiving Party may retain Confidential Information in accordance with its standard backup or record retention policies or as required by law, but the terms of this MNDA will continue to apply to the retained Confidential Information.</li>
<li><strong>Proprietary Rights</strong>. The Disclosing Party retains all of its intellectual property and other rights in its Confidential Information and its disclosure to the Receiving Party grants no license under such rights.</li>
<li><strong>Disclaimer</strong>. ALL CONFIDENTIAL INFORMATION IS PROVIDED “AS IS”, WITH ALL FAULTS, AND WITHOUT WARRANTIES, INCLUDING THE IMPLIED WARRANTIES OF TITLE, MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE.</li>
<li><strong>Governing Law and Jurisdiction</strong>. This MNDA and all matters relating hereto are governed by, and construed in accordance with, the laws of the State of Governing Law, without regard to the conflict of laws provisions of such Governing Law. Any legal suit, action, or proceeding relating to this MNDA must be instituted in the federal or state courts located in Jurisdiction. Each party irrevocably submits to the exclusive jurisdiction of such Jurisdiction in any such suit, action, or proceeding.</li>
<li><strong>Equitable Relief</strong>. A breach of this MNDA may cause irreparable harm for which monetary damages are an insufficient remedy. Upon a breach of this MNDA, the Disclosing Party is entitled to seek appropriate equitable relief, including an injunction, in addition to its other remedies.</li>
<li><strong>General</strong>. Neither party has an obligation under this MNDA to disclose Confidential Information to the other or proceed with any proposed transaction. Neither party may assign this MNDA without the prior written consent of the other party, except that either party may assign this MNDA in connection with a merger, reorganization, acquisition or other transfer of all or substantially all its assets or voting securities. Any assignment in violation of this Section is null and void. This MNDA will bind and inure to the benefit of each party’s permitted successors and assigns. Waivers must be signed by the waiving party’s authorized representative and cannot be implied from conduct. If any provision of this MNDA is held unenforceable, it will be limited to the minimum extent necessary so the rest of this MNDA remains in effect. This MNDA (including the Cover Page) constitutes the entire agreement of the parties with respect to its subject matter, and supersedes all prior and contemporaneous understandings, agreements, representations, and warranties, whether written or oral, regarding such subject matter. This MNDA may only be amended, modified, waived, or supplemented by an agreement in writing signed by both parties. Notices, requests and approvals under this MNDA must be sent in writing to the email or postal addresses on the Cover Page and are deemed delivered on receipt. This MNDA may be executed in counterparts, including electronic copies, each of which is deemed an original and which together form the same agreement.</li>
</ol>
<p><small>Common Paper Mutual Non-Disclosure Agreement Version 1.0 free to use under CC BY 4.0 (creativecommons.org/licenses/by/4.0).</small></p>
`
