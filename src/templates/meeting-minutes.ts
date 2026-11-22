/**
 * Template: Meeting minutes.
 *
 * A plain business document. Every value is a field in <mark>[...]</mark> that the person fills
 * in; no terms of any kind are written in. The same HTML as the Meeting minutes template in Untrace
 * Drive's editor, byte for byte (test/templates.test.ts pins its sha256).
 */

export const MEETING_MINUTES_HTML = `<h1>Meeting minutes</h1>
<p><strong><mark>[Meeting title]</mark></strong></p>
<table>
<tbody>
<tr><td><strong>Date</strong></td><td><mark>[Date]</mark></td></tr>
<tr><td><strong>Time</strong></td><td><mark>[Start time]</mark> to <mark>[End time]</mark></td></tr>
<tr><td><strong>Location</strong></td><td><mark>[Location]</mark></td></tr>
<tr><td><strong>Chair</strong></td><td><mark>[Chair]</mark></td></tr>
<tr><td><strong>Note taker</strong></td><td><mark>[Note taker]</mark></td></tr>
</tbody>
</table>
<h2>Attendees</h2>
<p><mark>[Attendees, separated by commas]</mark></p>
<h2>Apologies</h2>
<p><mark>[People who could not attend]</mark></p>
<h2>Agenda</h2>
<ol>
<li><mark>[Agenda item 1]</mark></li>
<li><mark>[Agenda item 2]</mark></li>
<li><mark>[Agenda item 3]</mark></li>
</ol>
<h2>Discussion</h2>
<h3>1. <mark>[Agenda item 1]</mark></h3>
<p><mark>[Discussion of item 1]</mark></p>
<h3>2. <mark>[Agenda item 2]</mark></h3>
<p><mark>[Discussion of item 2]</mark></p>
<h3>3. <mark>[Agenda item 3]</mark></h3>
<p><mark>[Discussion of item 3]</mark></p>
<h2>Decisions</h2>
<ul>
<li><mark>[Decision 1]</mark></li>
<li><mark>[Decision 2]</mark></li>
</ul>
<h2>Action items</h2>
<table>
<thead><tr><th>Action</th><th>Owner</th><th>Due date</th></tr></thead>
<tbody>
<tr><td><mark>[Action 1]</mark></td><td><mark>[Owner]</mark></td><td><mark>[Due date]</mark></td></tr>
<tr><td><mark>[Action 2]</mark></td><td><mark>[Owner]</mark></td><td><mark>[Due date]</mark></td></tr>
<tr><td><mark>[Action 3]</mark></td><td><mark>[Owner]</mark></td><td><mark>[Due date]</mark></td></tr>
</tbody>
</table>
<h2>Next meeting</h2>
<p><mark>[Date, time and location of the next meeting]</mark></p>`
