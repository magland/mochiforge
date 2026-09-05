// The structural stylesheet. Every color, radius, and font here comes from a
// custom property defined by the active theme (see themes.ts); nothing in
// this file names a color directly, so a new theme needs no changes here.
//
// The page is built from rules rather than from cards. A section is a 2px
// rule the width of the column, a caption under it, and then the content,
// and not a bordered panel with a filled strip across its top. The rule runs
// edge to edge while everything under it is inset by 12px, so the rule reads
// as the thing the section hangs from. A border on all four sides is reserved
// for what the reader can operate: buttons, inputs, menus, and list items that
// are themselves links. So a border means "this is a control" and a rule means
// "a section starts here". Fills are for code, which needs an edge of its own,
// and for the one row a menu or a form uses to separate itself from the page.
//
// When something must be flagged rather than merely divided, a merge state or
// a flash or an error, it takes a 3px rule down its left side in the colour of
// the news it carries. Nothing is a stadium: a pill that reports a state is a
// rectangle with the sheet's own corner radius, so the shape of a badge is the
// shape of a button and a reader learns one vocabulary rather than two.
//
// Two shapes come back from the mark in logo.ts. The square marks the active
// tab and stands in for a language's colour in the share list, and the
// monoline is why every rule on the page is one of two weights and no more.

export const CSS = `
/* The scale. Colour, radius, and the faces belong to the theme; spacing,
   type, and measure belong to the sheet, so they live here as their own set
   of properties and every rule below draws from them rather than from a fresh
   round number. Six steps of space and six of type is enough for the whole
   interface, and holding to them is what gives a page its rhythm. */
:root {
  --s1: 4px;
  --s2: 8px;
  --s3: 12px;
  --s4: 16px;
  --s5: 24px;
  --s6: 32px;
  --s7: 48px;
  --t-xs: 12px;
  --t-sm: 13px;
  --t-base: 15px;
  --t-lg: 17px;
  --t-xl: 20px;
  --t-2xl: 26px;
  /* The column the interface is read in. */
  --page: 1120px;
  /* The narrower column prose is read in. A line much past a hundred
     characters loses the eye on its way back to the left margin, so a README
     or an issue is capped even where the page has room to spare. Code, tables,
     and images inside it still take the width they need. */
  --measure: 820px;
  /* The least height of anything that has to be hit. A 28px button is a fine
     target for a pointer and a poor one for a thumb, so the number is raised
     rather than the layout redrawn when the pointer is coarse. */
  --touch: 30px;
}
@media (pointer: coarse) {
  :root { --touch: 42px; }
}
* { box-sizing: border-box; }
/* The hidden attribute always wins, including over a display this sheet set:
   scripts show and hide parts of a page by toggling it, and a .age-unlock
   form (display: flex) must actually vanish when unlocking hides it. */
[hidden] { display: none !important; }
/* The bar at the top stays put, so an anchored line or heading has to be
   pushed clear of it when the page jumps to one. */
html { scroll-padding-top: 68px; }
body {
  margin: 0;
  font-family: var(--font-ui);
  font-size: var(--t-base);
  line-height: 1.55;
  color: var(--fg);
  background: var(--bg);
  -webkit-text-size-adjust: 100%;
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
code, pre, .mono { font-family: var(--font-mono); }
/* One focus ring for everything a keyboard can reach. It is drawn only for
   focus that came from the keyboard, so a clicked button does not light up,
   and it sits outside the element's own border so a bordered control does not
   have to give up its edge to show it. */
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.container { max-width: var(--page); margin: 0 auto; padding: 0 var(--s4); }
/* The bar carries the way out of wherever the reader is, so it stays in view
   rather than scrolling off the top of a long file or a long thread. */
.topbar {
  position: sticky; top: 0; z-index: 30;
  background: var(--surface); border-bottom: 1px solid var(--border);
  margin-bottom: 1em;
}
.topbar .container { display: flex; align-items: center; gap: var(--s3); height: 52px; }
/* The brand is the logotype from logo.ts, which inherits the text colour. Its
   250 x 75 box runs ascender to descender, the g's tail being the one thing
   below the baseline, and the x-height band spans 20 to 60, so 20px here puts
   the x-height at 10.7px and the word at 66.7px wide. */
.brand { display: flex; align-items: center; color: var(--fg); flex: none; }
.brand svg { display: block; height: 20px; width: auto; }
.brand:hover { text-decoration: none; }
/* The address in the bar gives way before anything else does: it shortens to
   an ellipsis rather than pushing the account menu off the side of a phone. */
.topbar .crumbs {
  color: var(--fg-subtle); font-size: var(--t-sm); flex: 0 1 auto; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
/* Quiet, because the page under it says the same thing in its own title. The
   bar's copy is there for after the title has scrolled away, and a locator
   that competed with the title would be read twice for no gain. */
.topbar .crumbs a { color: var(--fg-muted); }
.topbar .crumbs a:hover { color: var(--accent); }
.userbox { margin-left: auto; display: flex; align-items: center; gap: 12px; }
/* A square glyph button in the bar, the size the appearance menu's summary is,
   so the icons beside the account sit on one rhythm. */
.topbar-icon {
  display: flex; align-items: center; justify-content: center;
  width: var(--touch); height: var(--touch); border-radius: var(--radius); color: var(--fg-muted);
}
.topbar-icon:hover { background: var(--surface-hover); color: var(--fg); text-decoration: none; }
.user-menu > summary { display: flex; align-items: center; gap: 2px; }
.user-menu .dropdown-menu { width: 220px; }
.user-menu form { margin: 0; }

/* --- the jump box ---

   The one control that goes from any page to any repository. In the bar it
   reads as a search field rather than a button, because that is what pressing
   it gives, and it carries its own keystroke so the shortcut is discovered by
   people who never read a help page. On a phone the words go and the glyph
   stays, since the bar has no room for a field that opens another field. */
.jump-open {
  display: inline-flex; align-items: center; gap: 6px;
  height: var(--touch); padding: 0 8px 0 10px;
  background: var(--input-bg); border: 1px solid var(--border); border-radius: var(--radius);
  color: var(--fg-subtle); font: inherit; font-size: var(--t-sm); cursor: pointer;
}
.jump-open:hover { border-color: var(--accent-soft); color: var(--fg-muted); }
.jump-open .glyph { color: var(--fg-subtle); flex: none; }
.jump-label { min-width: 96px; text-align: left; }
kbd {
  font: inherit; font-family: var(--font-mono); font-size: 11px; line-height: 1;
  padding: 3px 5px; border: 1px solid var(--border); border-bottom-width: 2px;
  border-radius: 4px; background: var(--surface); color: var(--fg-subtle);
}
.jump::backdrop { background: var(--overlay); }
.jump {
  width: min(560px, calc(100vw - 2 * var(--s4)));
  padding: 0; border: 1px solid var(--border); border-radius: var(--radius);
  background: var(--bg); color: var(--fg);
  box-shadow: 0 16px 48px var(--shadow);
  /* Near the top rather than centred: the list grows downwards, and a box that
     re-centres itself as results arrive is a box whose first result moves out
     from under the pointer. */
  margin: 12vh auto auto;
}
.jump-field { display: flex; align-items: center; gap: var(--s2); padding: 0 var(--s4); border-bottom: 1px solid var(--border-soft); }
.jump-glyph { color: var(--fg-subtle); flex: none; }
/* The dialog's own edge is the field's edge, so the input draws none of its
   own. Matched on the attribute as well as the class, or the general rule for
   text inputs further down the sheet would put a box back around it. */
.jump-field input[type="text"] {
  flex: 1; width: auto; max-width: none; border: 0; background: transparent; color: var(--fg);
  font: inherit; font-size: var(--t-lg); padding: 14px 0;
}
.jump-field input:focus { outline: none; }
.jump-list { list-style: none; margin: 0; padding: var(--s2) 0; max-height: 52vh; overflow-y: auto; }
.jump-group {
  padding: var(--s2) var(--s4) 4px;
  font-size: var(--t-xs); text-transform: uppercase; letter-spacing: 0.06em;
  color: var(--fg-subtle);
}
.jump-item {
  display: flex; align-items: center; gap: var(--s2);
  padding: 7px var(--s4); min-height: var(--touch);
  color: var(--fg); font-size: var(--t-sm);
  min-width: 0;
}
/* Both halves of a row stay on their own line, cut with an ellipsis, so a
   long repository name can never widen the panel or wrap its note. */
.jump-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.jump-note { flex: none; max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.jump-item:hover { text-decoration: none; }
/* The highlight follows the keyboard, and the pointer moves the keyboard, so
   there is only ever one selected row however the reader is driving. */
.jump-item.on { background: var(--accent); color: var(--on-primary); }
.jump-note { margin-left: auto; color: var(--fg-subtle); font-size: var(--t-xs); }
.jump-item.on .jump-note { color: inherit; opacity: 0.75; }
.jump-empty { padding: var(--s4); color: var(--fg-subtle); font-size: var(--t-sm); }
.jump-foot {
  display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
  padding: var(--s2) var(--s4); border-top: 1px solid var(--border-soft);
  color: var(--fg-subtle); font-size: var(--t-xs);
}
@media (max-width: 700px) {
  .jump-label, .jump-key { display: none; }
  .jump-open { padding: 0 8px; }
  .jump { margin-top: 6vh; }
  .jump-foot { display: none; }
}

/* An identicon in its frame (see avatar.ts): a circle for a person, a rounded
   square for a collection, so the two kinds of owner are told apart without
   reading the name under them. */
.avatar { display: inline-flex; flex: none; border-radius: 50%; overflow: hidden; background: var(--surface); }
.avatar.square { border-radius: var(--radius); }
.avatar svg { display: block; width: 100%; height: 100%; }
.with-avatar { display: flex; align-items: center; gap: 8px; }

/* The file finder: one box, and the tree under it. */
.find-input {
  width: 100%; padding: 8px 14px; font-size: 15px; font-family: inherit; margin-bottom: 12px;
  border: 1px solid var(--border); border-radius: var(--radius); background: var(--input-bg); color: var(--fg);
}
.find-list { border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
.find-item {
  display: flex; align-items: center; gap: 8px; padding: 6px 12px; color: var(--fg);
  border-top: 1px solid var(--border-soft); font-family: var(--font-mono); font-size: 12px;
}
.find-item:first-child { border-top: none; }
.find-item:hover { background: var(--surface); text-decoration: none; }
.find-item .icon { margin-right: 0; }

.list-filter {
  width: 320px; max-width: 100%; padding: 5px 12px; font-size: 14px; font-family: inherit;
  border: 1px solid var(--border); border-radius: var(--radius); background: var(--input-bg); color: var(--fg);
}
.btn-link { border: none; background: none; padding: 0; font: inherit; color: var(--accent); cursor: pointer; }
.btn-link:hover { text-decoration: underline; }
main { padding: var(--s5) var(--s4) var(--s7); }
/* The foot of every page, carrying the build stamp and nothing else (see
   buildStamp in views.ts). It is set small and quiet because it is looked up
   rather than read: an operator checking which build is live wants it to be
   there, and everybody else wants it out of the way. Ordinary inline flow, so
   a narrow screen wraps the line instead of scrolling it. */
.pagefoot { border-top: 1px solid var(--border); margin-top: 1em;}
.pagefoot .container { padding-top: var(--s3); padding-bottom: var(--s5); color: var(--fg-subtle); font-size: var(--t-xs); }
.pagefoot .mono { font-size: 11px; }
.foot-sep { color: var(--border); }
/* Titles are set larger than the body by a clear step rather than a nudge, so
   the top of a page announces itself and the reader knows where they are
   before reading a word of the content. */
h1 { font-family: var(--font-head); font-size: var(--t-2xl); line-height: 1.25; letter-spacing: -0.01em; margin: 0 0 var(--s4); }
h2 { font-family: var(--font-head); font-size: var(--t-xl); line-height: 1.3; }
h3 { font-family: var(--font-head); font-size: var(--t-lg); line-height: 1.35; }
.muted { color: var(--fg-muted); }
.small { font-size: var(--t-xs); }
.page-head { display: flex; align-items: center; justify-content: space-between; gap: var(--s3); margin-bottom: var(--s4); flex-wrap: wrap; }
.page-head h1, .page-head h2 { margin: 0; }

/* Icons are inline SVG (see icons.ts). text-bottom is what sits a 16px glyph
   on the same baseline as the label beside it; flex:none keeps one from being
   squeezed when it sits in a flex row. */
.glyph { display: inline-block; vertical-align: text-bottom; flex: none; overflow: visible; }

/* On a repository's pages there is no h1: the address is the title, so it is
   set at the size a title is set at, and the repository's own name carries the
   weight while the collection before it stays plain. */
.repo-title { display: flex; align-items: center; gap: var(--s2); font-size: var(--t-xl); margin-bottom: var(--s2); }
.repo-title .icon { color: var(--fg-muted); margin-right: 0; }
.repo-title b { font-weight: 600; }
/* The repository's sections. The active one is marked by the square from the
   mark in logo.ts, set under the middle of the label and clear of the rule,
   rather than by a bar drawn under the tab's whole width. The marker is
   inside the tab's padding box because .tabs scrolls sideways on a narrow
   screen, and anything hanging below it would be clipped. */
.tabs {
  display: flex; gap: var(--s1); border-bottom: 1px solid var(--border);
  margin-bottom: var(--s4); overflow-x: auto;
  /* The row scrolls on a narrow screen. A scrollbar under it would read as a
     second rule beside the one the tabs already hang from, so it is taken away
     and the row fades out at its trailing edge instead. A tab cut off square at
     the screen's edge reads as a page too wide for the phone; a tab fading out
     reads as a row that continues. The mask is an alpha ramp and not a colour,
     which is why it works over whatever the theme paints behind it. */
  scrollbar-width: none; -webkit-overflow-scrolling: touch;
  mask-image: linear-gradient(to right, black calc(100% - 28px), transparent 100%);
}
.tabs::-webkit-scrollbar { display: none; }
.tab {
  position: relative; display: flex; align-items: center; gap: var(--s2); white-space: nowrap;
  padding: var(--s2) var(--s3) 14px; color: var(--fg);
}
.tab .glyph { color: var(--fg-muted); }
.tab:hover { color: var(--accent); text-decoration: none; }
.tab:hover .glyph { color: var(--accent); }
.tab.active { font-weight: 600; }
.tab.active .glyph { color: var(--fg); }
.tab.active::after {
  content: ''; position: absolute; left: 50%; bottom: 4px; margin-left: -3px;
  width: 6px; height: 6px; background: var(--tab-marker);
}
/* A count beside a label is data, not decoration: it is set in the mono face
   and left unenclosed. */
.counter { font-family: var(--font-mono); font-size: 12px; color: var(--fg-subtle); margin-left: 6px; }
/* A word set against a name: Default, and its kin. */
.badge { display: inline-block; border: 1px solid var(--accent); color: var(--accent); border-radius: var(--radius); padding: 0 6px; font-size: 12px; line-height: 18px; }
.ref-name { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.ref-name .icon { color: var(--fg-muted); margin-right: 0; }
.ref-name div { flex-basis: 100%; }
.ref-form { padding: 16px; width: 300px; }
.ref-form .field:last-of-type { margin-bottom: 16px; }

.toolbar { display: flex; align-items: center; justify-content: space-between; gap: var(--s3); margin-bottom: var(--s3); flex-wrap: wrap; }
/* flex:1 is load-bearing: a wrapping flex container's max-content width is its
   widest item rather than the sum, so without it .left collapses to the ref
   selector and drops the breadcrumb onto a second line. */
.toolbar .left { display: flex; align-items: center; gap: var(--s3); flex-wrap: wrap; flex: 1 1 auto; min-width: 0; }
/* A row of buttons wraps rather than running off the side of the page. Without
   this the four controls on a tree page (Go to file, History, Fork, Code) are
   wider than a phone, and the last of them is simply unreachable. */
.right-group { display: flex; align-items: center; gap: var(--s2) 6px; flex-wrap: wrap; min-width: 0; }
.crumb { font-size: var(--t-base); }
.crumb b { font-weight: 600; }

/* Menus: a <details> whose summary is a button and whose body is a popover.
   The ref picker, the Code button, and the workflow dispatch form all use it. */
.dropdown { position: relative; }
.dropdown > summary { list-style: none; cursor: pointer; }
.dropdown > summary::-webkit-details-marker { display: none; }
.dropdown > summary .caret { opacity: 0.7; }
.dropdown-menu {
  position: absolute; left: 0; z-index: 20; margin-top: 6px; width: 320px; max-width: 92vw;
  background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius);
  box-shadow: 0 8px 24px var(--shadow); text-align: left; overflow: hidden;
}
.dropdown-menu.dd-right { left: auto; right: 0; }
.dropdown-menu > .cmd-row, .dropdown-menu > p { margin: 10px 12px; }
.dd-section {
  padding: 8px 12px; font-size: 12px; font-weight: 600; color: var(--fg-muted);
  border-bottom: 1px solid var(--border-soft); background: var(--surface);
}
.dd-group + .dd-group .dd-section { border-top: 1px solid var(--border-soft); }
.dd-filter {
  display: block; width: calc(100% - 24px); margin: 10px 12px; padding: 5px 10px; font-size: 13px;
  border: 1px solid var(--border); border-radius: var(--radius); background: var(--input-bg); color: var(--fg);
}
.dd-scroll { max-height: 320px; overflow-y: auto; }
.dd-item {
  display: flex; align-items: center; gap: 8px; padding: 7px 12px; color: var(--fg);
  border-top: 1px solid var(--border-soft); font-size: 13px;
}
.dd-item:first-child { border-top: none; }
.dd-item:hover { background: var(--surface); text-decoration: none; }
button.dd-item { width: 100%; background: none; font: inherit; font-size: 13px; cursor: pointer; }
.dd-item.current { font-weight: 600; }
.dd-item .dd-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dd-check { width: 16px; flex: none; color: var(--accent); }
.dd-current { max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* Appearance menu. The check column keeps its width whether or not the glyph is
   showing, so the labels do not shift as the reader moves between themes. */
.theme-menu > summary {
  display: flex; align-items: center; justify-content: center;
  width: var(--touch); height: var(--touch); border-radius: var(--radius); color: var(--fg-muted);
}
.theme-menu > summary:hover { background: var(--surface-hover); color: var(--fg); }
.theme-menu .dropdown-menu { width: 200px; }
.theme-item { text-align: left; }
.theme-check { width: 16px; flex: none; color: var(--accent); visibility: hidden; }
[aria-checked='true'] > .theme-check { visibility: visible; }
[aria-checked='true'].theme-item { font-weight: 600; }
.clone-menu .cmd-row input {
  flex: 1; min-width: 0; padding: 5px 8px; font-size: 12px; border: 1px solid var(--border);
  border-radius: var(--radius); background: var(--input-bg); color: var(--fg); font-family: var(--font-mono);
}
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  min-height: var(--touch); padding: 4px var(--s3); font-size: var(--t-sm);
  border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface);
  color: var(--fg); cursor: pointer; font-family: inherit; line-height: 1.5; white-space: nowrap;
}
.btn:hover { background: var(--surface-hover); text-decoration: none; }
.btn-primary { background: var(--primary); border-color: var(--primary); color: var(--on-primary); font-weight: 600; }
.btn-primary:hover { background: var(--primary-hover); }
.btn-danger { background: var(--danger); border-color: var(--danger); color: var(--on-danger); font-weight: 600; }
.btn-danger:hover { background: var(--danger-hover); }
.btn-danger-outline { color: var(--danger); }
.btn-danger-outline:hover { background: var(--danger); border-color: var(--danger); color: var(--on-danger); }

/* The repository root: the listing beside the About panel, stacking on a
   narrow screen. Every other tree page is one column. */
.repo-layout { display: flex; align-items: flex-start; gap: 24px; }
.repo-main { flex: 1 1 auto; min-width: 0; }
.repo-side { flex: 0 0 296px; }
/* The panel beside the listing is divided the way the rest of the page is:
   each block hangs from its own rule under an uppercase caption, so About,
   Contributors, and Languages read as three sections of one column rather than
   as three stacked cards. The first block's rule lines up with the listing's. */
.side-block { border-top: 2px solid var(--border); padding: var(--s3) 0 var(--s4); }
.side-block:last-child { padding-bottom: 0; }
.side-block h3 {
  display: flex; align-items: center; gap: var(--s2); margin: 0 0 var(--s2);
  font-family: var(--font-head); font-size: var(--t-sm); font-weight: 600;
  letter-spacing: 0.04em; text-transform: uppercase;
}
.side-edit { margin-left: auto; color: var(--fg-muted); display: flex; }
.side-edit:hover { color: var(--accent); }
.side-desc { margin: 0 0 12px; }
.side-links { display: flex; flex-direction: column; gap: 8px; }
.side-links a { display: flex; align-items: center; gap: 8px; color: var(--fg); font-size: 13px; }
.side-links a:hover { color: var(--accent); text-decoration: none; }
.side-links .glyph { color: var(--fg-muted); }
/* When a two-column layout stacks, align-items has to be released along with
   the direction: flex-start on a column means "as wide as your content", which
   leaves the listing and the readme narrower than the panel that was beside
   them a moment ago. Every stacking layout below does the same. */
@media (max-width: 1000px) {
  .repo-layout { flex-direction: column; align-items: stretch; }
  .repo-side { flex: 1 1 auto; width: 100%; }
}

/* A listing is a rule, a caption row where there is one, and then the rows.
   It has no frame: the page's column is its left and right edge. */
table.listing { width: 100%; border-collapse: collapse; border-top: 2px solid var(--border); }
table.listing th {
  text-align: left; font-family: var(--font-head); font-size: 12px; font-weight: 600;
  letter-spacing: 0.06em; text-transform: uppercase; color: var(--fg-muted);
  padding: 8px 12px; border-bottom: 1px solid var(--border);
}
table.listing td { padding: 7px 12px; border-top: 1px solid var(--border-soft); }
table.listing tr:first-child td { border-top: none; }
table.listing tr:hover td { background: var(--surface); }
td.right, th.right { text-align: right; }
.icon { display: inline-block; width: 16px; text-align: center; margin-right: 6px; color: var(--accent-soft); }
.icon.file { color: var(--fg-subtle); }

/* The link to a repository's published site, in a collection listing. It sits
   after the name as an icon alone, muted until the row is pointed at, so it
   reads as an aside to the repository rather than a second name. */
.site-link { display: inline-flex; vertical-align: text-bottom; margin-left: 8px; color: var(--fg-subtle); }
.site-link:hover { color: var(--accent); }

/* Tree listings: name, then the message and age of the commit that last
   touched the entry. The name column is sized to the content so long file
   names are not truncated, and the message column takes the slack. */
table.listing.tree td.tree-name { width: 1%; white-space: nowrap; }
table.listing.tree td.tree-message { max-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
table.listing.tree td.tree-message a { color: var(--fg-muted); }
table.listing.tree td.tree-message a:hover { color: var(--accent); }
table.listing.tree td.tree-age { width: 1%; white-space: nowrap; }
@media (max-width: 700px) {
  table.listing.tree td.tree-message { display: none; }
}

/* The last commit to touch the tree sits on the listing's own rule and is
   divided from the rows by a hairline, so the two read as one section. */
.latest-commit {
  display: flex; justify-content: space-between; gap: 12px; align-items: center; flex-wrap: wrap;
  border-top: 2px solid var(--border); border-bottom: 1px solid var(--border);
  padding: 8px 12px;
}
.latest-commit + table.listing { border-top: none; }
.latest-commit .lc-main { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.latest-commit .lc-main a { color: var(--fg-muted); }
.latest-commit .lc-main a:hover { color: var(--accent); }
.latest-commit .lc-meta { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.lc-history { display: flex; align-items: center; gap: 6px; color: var(--fg); padding-left: 8px; border-left: 1px solid var(--border); }
.lc-history:hover { color: var(--accent); text-decoration: none; }
.lc-history .glyph { color: var(--fg-muted); }

/* A section of the page: the rule, the caption on it, and the content under
   it, running the full width of the column rather than sitting inside a
   frame. The caption is in the display face so that it reads as a title and
   not as a row of the content. */
.box { border-top: 2px solid var(--border); margin-top: var(--s5); }
/* The caption on a section's rule carries the page's colour and weight rather
   than the muted grey of secondary text: it is the answer to "what is this",
   and a page whose every caption recedes reads as one undivided field. It is
   not set in capitals, because some of these captions are a filename and one
   of them is a whole sentence; the weight is what does the work. */
.box-header {
  display: flex; align-items: center; gap: var(--s2); padding: 9px var(--s3) 8px;
  border-bottom: 1px solid var(--border-soft);
  font-family: var(--font-head); font-size: var(--t-sm); font-weight: 600;
  letter-spacing: 0.01em; color: var(--fg);
}
.box-header .glyph { color: var(--fg-subtle); }
.box-body { padding: var(--s4) var(--s3) var(--s1); }
.box-header a { color: var(--fg); }
.box-header a:hover { color: var(--accent); text-decoration: none; }

.code-meta {
  display: flex; justify-content: space-between; align-items: center; gap: 12px;
  border-top: 2px solid var(--border); border-bottom: 1px solid var(--border);
  padding: 7px 12px;
}
/* The file view is one element per line, so a line can be linked to and
   highlighted when linked to (#L12). The row is as wide as its content but
   never narrower than the viewport, which is what lets the highlight run the
   full width; the number stays put while the code scrolls under it. */
.code-lines {
  background: var(--code-bg); overflow-x: auto; padding: 8px 0;
  font-family: var(--font-mono); font-size: 12px; line-height: 20px;
}
.cline { display: flex; width: max-content; min-width: 100%; }
.cline:target { background: var(--line-mark); }
.lnum {
  position: sticky; left: 0; z-index: 1; flex: none; width: 56px; padding: 0 12px 0 8px;
  text-align: right; color: var(--fg-subtle); background: var(--code-bg); user-select: none;
}
.lnum:hover { color: var(--fg-muted); text-decoration: none; }
.cline:target .lnum { background: var(--line-mark); color: var(--fg-muted); }
.ltext { white-space: pre; padding: 0 16px 0 4px; }
.blob-image { padding: 24px; text-align: center; background: var(--code-bg); }
.blob-image img { max-width: 100%; }
.blob-binary { padding: 32px; text-align: center; color: var(--fg-muted); }
.rendered { padding: 24px 12px 28px; background: var(--bg); }

/* Age-encrypted files: the unlock card on the blob page and in the editor,
   the passphrase pair the new-file form reveals for a .age name, the slim
   bar that stands over decrypted output, and the show/hide eye every
   passphrase input carries. */
.age-card { text-align: center; }
.age-head { display: inline-flex; align-items: center; gap: 8px; color: var(--fg); margin-bottom: 4px; }
.age-unlock { display: flex; justify-content: center; gap: 8px; margin: 12px 0 4px; flex-wrap: wrap; }
.age-unlock .age-pass-wrap { width: min(320px, 100%); }
.age-pass-wrap { position: relative; display: inline-flex; align-items: center; }
.age-pass-wrap input { width: 100%; padding-right: 36px; }
.age-eye {
  position: absolute; right: 3px; display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; padding: 0; border: 0; border-radius: var(--radius);
  background: none; color: var(--fg-subtle); cursor: pointer;
}
.age-eye:hover { color: var(--fg); }
.age-eye .glyph-eye-off, .age-pass-wrap.showing .glyph-eye { display: none; }
.age-pass-wrap.showing .glyph-eye-off { display: block; }
.age-card .form-error { display: inline-block; margin-top: 10px; }
.age-card .field { max-width: 360px; margin-left: auto; margin-right: auto; text-align: left; }
.age-card .field .age-pass-wrap { display: flex; }
.age-bar {
  display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;
  padding: 8px 12px; margin-bottom: 12px;
  border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface);
}
.age-bar-note { display: inline-flex; align-items: baseline; gap: 8px; color: var(--fg-muted); font-size: var(--t-sm); }
.age-bar-note .glyph, .age-warn .glyph { flex: none; transform: translateY(2px); }
.age-bar-actions { display: inline-flex; gap: 8px; }
p.age-bar-note { margin: 0 0 12px; }
.age-warn { display: flex; align-items: baseline; gap: 6px; color: var(--alert-warning); font-size: var(--t-sm); margin: 4px 0 0; }
.age-newpass { margin: 12px 0; }
.age-newpass > summary { cursor: pointer; color: var(--fg-muted); }
.age-newpass > summary:hover { color: var(--fg); }
.age-newpass .field { max-width: 360px; margin-top: 10px; }
.age-output .age-plain { padding: 16px; overflow-x: auto; background: var(--bg); font-size: 13px; line-height: 1.5; }

/* Segmented Preview/Code switch on rendered files. */
.seg { display: inline-flex; border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
.seg a { display: inline-flex; align-items: center; gap: 6px; padding: 4px 12px; font-size: 13px; line-height: 1.5; color: var(--fg-muted); background: var(--surface); }
.seg a + a { border-left: 1px solid var(--border); }
.seg a:hover { background: var(--surface-hover); text-decoration: none; }
.seg a.current { background: var(--chip-bg); color: var(--fg); font-weight: 600; }

.commit-row { display: flex; justify-content: space-between; gap: 12px; align-items: center; padding: 8px 12px; }
/* A day's commits hang under the day, which is a caption on its own rule. */
.commit-day {
  display: flex; align-items: center; gap: var(--s2); margin: var(--s5) 0 0; padding: 9px var(--s3) 8px;
  border-top: 2px solid var(--border); border-bottom: 1px solid var(--border-soft);
  font-family: var(--font-head); font-size: var(--t-sm); font-weight: 600;
  letter-spacing: 0.01em; color: var(--fg);
}
.commit-day .glyph { color: var(--fg-subtle); }
.commit-group .commit-row { border-top: 1px solid var(--border-soft); }
.commit-group .commit-row:first-child { border-top: none; }
.commit-main { display: flex; align-items: flex-start; gap: 10px; min-width: 0; }
.commit-main > span { min-width: 0; }
.commit-row .title { font-weight: 600; color: var(--fg); }
.commit-row .title:hover { color: var(--accent); }
.sha {
  font-family: var(--font-mono); font-size: 12px;
  background: var(--inline-code-bg); border-radius: var(--radius); padding: 2px 6px; color: var(--accent);
}
.pagination { display: flex; gap: 8px; justify-content: center; margin-top: 16px; }

.commit-head { border-top: 2px solid var(--border); border-bottom: 1px solid var(--border-soft); margin-bottom: 16px; }
.commit-head .subject { font-family: var(--font-head); font-size: 17px; padding: 12px 12px 4px; }
.commit-head .body { padding: 0 12px; white-space: pre-wrap; color: var(--fg-muted); font-size: 13px; }
.commit-head .meta { display: flex; flex-wrap: wrap; gap: 16px; padding: 8px 12px 12px; color: var(--fg-muted); font-size: 12px; align-items: center; }

.diff-file { border-top: 2px solid var(--border); margin-bottom: 20px; }
.diff-file-header {
  border-bottom: 1px solid var(--border-soft); padding: 8px 12px;
  font-family: var(--font-mono); font-size: 12px;
}
.diff-body { overflow-x: auto; font-family: var(--font-mono); font-size: 12px; line-height: 20px; background: var(--code-bg); }
.dline { white-space: pre; padding: 0 10px; }
.dline.add { background: var(--diff-add); }
.dline.del { background: var(--diff-del); }
.dline.hunk { background: var(--diff-hunk); color: var(--fg-muted); }
.dline.meta { color: var(--fg-subtle); background: var(--diff-meta); }

/* Prose is capped at the reading measure even where the page has more room,
   because a line of text is easier to follow than to find your way back along.
   Code, tables, images, and display math are exempt by their own rules below:
   they take the width they need and scroll if they cannot get it. */
.markdown-body { font-size: var(--t-base); max-width: var(--measure); }
.markdown-body > *:first-child { margin-top: 0; }
.markdown-body > *:last-child { margin-bottom: 0; }
.markdown-body h1, .markdown-body h2, .markdown-body h3 { font-family: var(--font-head); }
.markdown-body h1 { font-size: 1.7em; border-bottom: 1px solid var(--border-soft); padding-bottom: 0.3em; margin: 0.7em 0 0.5em; }
.markdown-body h2 { font-size: 1.4em; border-bottom: 1px solid var(--border-soft); padding-bottom: 0.3em; }
.markdown-body h3 { font-size: 1.15em; }
.markdown-body code { background: var(--inline-code-bg); padding: 0.2em 0.4em; border-radius: var(--radius); font-size: 85%; }
.markdown-body pre { margin: 0; background: var(--surface); padding: 16px; border-radius: var(--radius); overflow-x: auto; }
.markdown-body pre code { background: none; padding: 0; font-size: 12px; }

/* Fenced code: the copy button keeps out of the way until the pointer is
   over the block it belongs to. */
.markdown-body .code-block { position: relative; margin: 1em 0; }
.markdown-body .code-block .copy-btn { position: absolute; top: 8px; right: 8px; opacity: 0; transition: opacity 0.1s; }
.markdown-body .code-block:hover .copy-btn, .markdown-body .code-block .copy-btn:focus { opacity: 1; }

.heading-anchor { margin-left: 8px; font-weight: 400; color: var(--fg-subtle); opacity: 0; }
.markdown-body h1:hover .heading-anchor, .markdown-body h2:hover .heading-anchor,
.markdown-body h3:hover .heading-anchor, .markdown-body h4:hover .heading-anchor,
.markdown-body h5:hover .heading-anchor, .markdown-body h6:hover .heading-anchor,
.heading-anchor:focus { opacity: 1; text-decoration: none; }

.markdown-body li.task-item { list-style: none; margin-left: -1.3em; }
.markdown-body li.task-item input[type="checkbox"] { margin-right: 6px; }

/* Alert callouts: > [!NOTE] and friends. The syntax is the one authors
   already write; the drawing is this sheet's, a left rule in the colour of
   the notice, which is what every other flagged thing here gets. */
.markdown-body blockquote.alert { border-left-color: var(--alert); color: var(--fg); }
.markdown-body .alert-title { font-weight: 600; color: var(--alert); margin: 0 0 4px; }
.markdown-body .alert-note { --alert: var(--accent); }
.markdown-body .alert-tip { --alert: var(--alert-tip); }
.markdown-body .alert-important { --alert: var(--alert-important); }
.markdown-body .alert-warning { --alert: var(--alert-warning); }
.markdown-body .alert-caution { --alert: var(--danger); }

/* Math. Display math scrolls sideways rather than widening the page. */
.markdown-body .math-block { overflow-x: auto; overflow-y: hidden; margin: 1em 0; }
.markdown-body .katex-display { margin: 0; padding: 2px 0; }
.markdown-body .math-error { color: var(--danger); }

.markdown-body .footnotes { font-size: 13px; color: var(--fg-muted); }
.markdown-body .footnotes-sep { margin-top: 32px; }
.markdown-body .footnote-backref { text-decoration: none; }
.markdown-body kbd {
  font-family: var(--font-mono); font-size: 85%; padding: 2px 5px; border: 1px solid var(--border);
  border-bottom-width: 2px; border-radius: var(--radius); background: var(--surface);
}
.markdown-body summary { cursor: pointer; font-weight: 600; }
.markdown-body blockquote { margin: 0; padding-left: 16px; border-left: 4px solid var(--border); color: var(--fg-muted); }
.markdown-body img { max-width: 100%; }
.markdown-body table { border-collapse: collapse; }
.markdown-body table th, .markdown-body table td { border: 1px solid var(--border); padding: 6px 12px; }
.markdown-body table th { background: var(--surface); }
.markdown-body table { display: block; overflow-x: auto; max-width: 100%; }
.markdown-body hr { border: none; border-top: 1px solid var(--border-soft); margin: 24px 0; }
.markdown-body li + li { margin-top: 0.25em; }
.markdown-body h1:target, .markdown-body h2:target, .markdown-body h3:target,
.markdown-body h4:target, .markdown-body h5:target, .markdown-body h6:target { scroll-margin-top: 16px; }

.cmd-row { display: flex; align-items: center; gap: 8px; margin: 4px 0; }
.cmd-row code {
  flex: 1; overflow-x: auto; white-space: pre; padding: 5px 8px; background: var(--input-bg);
  border: 1px solid var(--border); border-radius: var(--radius); font-size: 12px;
}
.copy-btn {
  display: inline-flex; align-items: center; padding: 4px 10px; font-size: 12px; border: 1px solid var(--border);
  border-radius: var(--radius); background: var(--surface); cursor: pointer; color: var(--fg);
  white-space: nowrap; font-family: inherit; line-height: 1.5;
}
.copy-btn:hover { background: var(--surface-hover); }
/* Both faces of the button are in the page; copying swaps which one shows.
   The faces are matched on their own class rather than through .copy-btn,
   because the same pair also sits inside a plain .btn on the file view. */
.copy-idle, .copy-done { display: inline-flex; align-items: center; gap: 6px; }
.copy-done { display: none; color: var(--alert-tip); }
.copied .copy-idle { display: none; }
.copied .copy-done { display: inline-flex; }
/* The command blocks on the empty-repository page: several lines with one
   button, where .cmd-row is one line with one button. */
.cmd-block { display: flex; align-items: flex-start; gap: 8px; margin: 4px 0 20px; }
.cmd-block pre {
  flex: 1; margin: 0; overflow-x: auto; padding: 10px 12px; background: var(--input-bg);
  border: 1px solid var(--border); border-radius: var(--radius); font-size: 12px; line-height: 20px;
}
.setup-head { font-family: var(--font-head); font-size: 15px; margin: 24px 0 8px; }

/* Nothing here yet. A frame on all four sides is this sheet's mark of
   something the reader can operate, and an empty listing is the one thing on
   the page they cannot, so it is drawn with space and a quieter colour instead
   of with a box around it. */
.empty-state { border-top: 2px solid var(--border); padding: var(--s7) var(--s4); text-align: center; color: var(--fg-muted); }
.empty-state b { color: var(--fg); }
/* When the empty notice is what a filtered-away listing leaves behind, the
   listing gives up its rule so the two do not show as a doubled line. */
table.listing:has(+ .empty-state:not([hidden])) { border-top: none; }
.error-page { text-align: center; padding: 64px 0; color: var(--fg-muted); }
.error-page .code { font-family: var(--font-head); font-size: 48px; font-weight: 700; color: var(--fg); }

/* Sign-in: the mark, a heading, and one narrow card, centred. */
.signin { max-width: 340px; margin: 40px auto; }
.signin-mark svg { display: block; width: 44px; height: 44px; margin: 0 auto 16px; color: var(--fg); }
.signin h1 { font-size: 20px; text-align: center; }
.signin .form-box { padding: 16px; }
.signin .btn { width: 100%; justify-content: center; }
.signin-note { margin: 16px 0 0; text-align: center; }
/* The passkey button under the token form: a quiet second door. */
.signin-alt { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border); }
.signin-alt .form-error { margin: 10px 0 0; }
/* A handoff code is read across a room, so it is set like a heading. */
.handoff-code { font-size: 28px; letter-spacing: 4px; text-align: center; padding: 16px 0; user-select: all; }

/* Two fields reading as one address, "collection / name". */
.name-row { display: flex; align-items: flex-end; gap: 8px; flex-wrap: wrap; }
.name-row .field { flex: 1 1 200px; margin-bottom: 0; }
.name-row .field input { width: 100%; }
.name-slash { font-size: 20px; color: var(--fg-muted); padding-bottom: 4px; }
hr.rule { border: none; border-top: 1px solid var(--border-soft); margin: 20px 0; }

/* A label that only a screen reader needs, where the placeholder or the
   surrounding heading already says what the field is. */
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }

.form-box { border: 1px solid var(--border); border-radius: var(--radius); padding: 20px 24px; max-width: 620px; }
.form-box.wide { max-width: 880px; }
.form-box h1, .form-box h2 { margin-top: 0; }
.field { margin-bottom: 14px; }
.field label { display: block; font-weight: 600; margin-bottom: 4px; }
.field label.checkbox { font-weight: 400; }
.field p { margin: 4px 0 0; }
input[type="text"], input[type="password"], select {
  width: 100%; max-width: 420px; padding: 5px 12px; font-size: 14px; font-family: inherit;
  border: 1px solid var(--border); border-radius: var(--radius); background: var(--input-bg); color: var(--fg);
}
.inline-form input[type="text"], .inline-form select { width: auto; }
input:focus, textarea:focus, select:focus { outline: 2px solid var(--focus); border-color: var(--accent); }
textarea.code-editor {
  width: 100%; padding: 10px 12px; font-size: 12px; line-height: 20px; tab-size: 4;
  font-family: var(--font-mono); border: 1px solid var(--border); border-radius: var(--radius);
  background: var(--input-bg); color: var(--fg); resize: vertical;
}
.commit-box { border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); padding: 12px 16px; margin-top: 12px; max-width: 620px; }
.commit-box .field { margin-bottom: 10px; }
.commit-box-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.commit-box input[type="text"], .commit-box textarea { max-width: 100%; }
textarea {
  width: 100%; max-width: 100%; padding: 6px 12px; font-size: 14px; font-family: inherit; line-height: 1.5;
  border: 1px solid var(--border); border-radius: var(--radius); background: var(--input-bg); color: var(--fg); resize: vertical;
}
.settings-box { max-width: 760px; }
.settings-box .box-body { padding: 16px 12px 8px; }
.actions { display: flex; gap: 8px; align-items: center; }
.file-head { font-weight: 400; }
.file-head .mono { font-weight: 600; }
.filename-row { display: flex; align-items: center; gap: 4px; }
.filename-row input { flex: 1; }
.inline-form { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 4px 0; }
.inline-form label { display: flex; align-items: center; gap: 6px; color: var(--fg-muted); font-size: 13px; }
.user-actions { padding: 12px; display: flex; flex-direction: column; gap: 10px; width: 380px; }
.user-actions .inline-form { margin: 0; }
.user-actions input[type="text"] { width: 100%; }
/* News, of either kind: the tint, and a rule down the side it is read from. */
.flash { background: var(--ok-bg); border-left: 3px solid var(--ok-border); padding: 8px 12px; margin-bottom: 16px; max-width: 620px; }
.form-error { background: var(--err-bg); border-left: 3px solid var(--err-border); padding: 8px 12px; margin-bottom: 16px; max-width: 620px; }
/* The amber grade of news: a saved setting the running server has not read
   yet, waiting for a restart. Not an error, so it takes the surface tint. */
.restart-note { background: var(--surface); border-left: 3px solid var(--alert-warning); padding: 8px 12px; margin-bottom: 16px; max-width: 620px; }
/* A section flagged by the colour of the news it carries, as the flashes and
   the merge box are. Two grades, because they are not the same warning: amber
   for what disrupts other people and can be put back, red for what is gone.
   A page where both wore red would teach the reader to read past red. */
.danger-zone { border-left: 3px solid var(--danger); padding: 4px 0 4px var(--s4); margin-top: var(--s5); max-width: 620px; }
.danger-zone h3 { margin-top: 0; color: var(--danger); }
.danger-zone.caution { border-left-color: var(--alert-warning); }
.danger-zone.caution h3 { color: var(--alert-warning); }

/* Administration: the sections down the left, the page beside them. */
.admin-layout { display: flex; align-items: flex-start; gap: 32px; }
.admin-main { flex: 1 1 auto; min-width: 0; }
.admin-side { flex: 0 0 220px; }
/* At the top of the page rather than beside content, so the block's ruled top
   would read as a stray line under the header; the heading carries it. */
.admin-side .side-block:first-child { border-top: 0; padding-top: var(--s2); }
.admin-side .side-links a { padding: 6px 8px; border-radius: var(--radius); }
.admin-side .side-links a:hover { background: var(--surface); }
.admin-side .side-links a.current { background: var(--surface); font-weight: 600; }
@media (max-width: 800px) {
  .admin-layout { flex-direction: column; align-items: stretch; gap: var(--s4); }
  .admin-side { flex: 1 1 auto; width: 100%; }
}
.with-avatar-row { display: flex; align-items: flex-start; gap: 8px; }
.with-avatar-row .icon { margin-right: 0; color: var(--fg-muted); }

/* One runner's facts: a label column narrow enough that the values line up,
   collapsing to stacked rows where that column would crowd the value. */
.facts { display: grid; grid-template-columns: 160px 1fr; gap: 8px 16px; max-width: 880px; margin: 16px 0; }
.facts .fact { display: contents; }
.facts .k { color: var(--fg-muted); font-size: 13px; }
.facts .v { min-width: 0; overflow-wrap: anywhere; }
@media (max-width: 640px) {
  .facts { grid-template-columns: 1fr; gap: 2px; }
  .facts .fact + .fact .k { margin-top: 10px; }
}
.runner-status { display: inline-flex; align-items: center; gap: 6px; }

.card-list { display: flex; flex-direction: column; gap: 12px; margin-bottom: 20px; max-width: 760px; }
.card-list a.card { display: block; border: 1px solid var(--border); border-radius: var(--radius); padding: 12px 16px; color: var(--fg); }
.card-list a.card:hover { background: var(--surface); text-decoration: none; }
.card-list a.card b { display: block; }

/* The day's egress against its budget: the number first, then one bar in the
   proportion used, coloured only as it gets close. Amber at four fifths rather
   than at the line, since the reason to look at this page is to act before the
   vault stops answering. */
.egress-total { display: flex; align-items: baseline; gap: 8px; margin-bottom: 6px; }
.egress-total b { font-size: 20px; }
.egress-meter { height: 6px; background: var(--chip-bg); border-radius: 3px; overflow: hidden; max-width: 620px; }
.egress-meter .fill { display: block; height: 100%; background: var(--fg-subtle); }
.egress-meter .fill.near { background: var(--alert-warning); }
.egress-meter .fill.over { background: var(--danger); }

.theme-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; margin-bottom: 20px; }
.theme-card { border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
.theme-card.current { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.theme-card label { display: block; cursor: pointer; }
.theme-swatch { padding: 12px 14px; border-bottom: 1px solid var(--border); }
.theme-swatch .bar { height: 8px; border-radius: 4px; margin-bottom: 8px; }
.theme-swatch .row { display: flex; gap: 6px; align-items: center; }
.theme-swatch .dot { width: 16px; height: 16px; border-radius: 50%; }
.theme-meta { padding: 10px 14px; }
.theme-meta .name { font-weight: 600; display: flex; align-items: center; gap: 8px; }
.theme-meta p { margin: 4px 0 0; }

/* --- Actions: runs, jobs, logs --- */
.chip { display: inline-block; background: var(--chip-bg); border-radius: var(--radius); padding: 1px 7px; font-size: 12px; color: var(--fg-muted); }
.run-status { display: inline-flex; align-items: center; justify-content: center; flex: none; }
.run-status.success { color: var(--alert-tip); }
.run-status.failure { color: var(--danger); }
/* A run in progress turns; a reader who has motion turned off gets the same
   amber ring, still. */
.run-status.running { color: var(--alert-warning); }
.run-status.running .glyph { animation: spin 1.4s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .run-status.running .glyph { animation: none; } }
.run-status.queued { color: var(--fg-subtle); }
.run-status.cancelled, .run-status.skipped { color: var(--fg-subtle); }
.listing.runs td.run-cell { display: flex; align-items: flex-start; gap: 10px; }
.listing.runs td.run-cell > span { min-width: 0; }
/* The runs, with the repository's workflows listed down the side. */
.actions-layout { display: flex; align-items: flex-start; gap: 24px; }
.actions-main { flex: 1 1 auto; min-width: 0; }
.wf-side { flex: 0 0 240px; }
.wf-side .side-links a { padding: 5px 8px; border-radius: var(--radius); }
.wf-side .side-links a:hover { background: var(--surface); }
.wf-side .side-links a.current { background: var(--surface); font-weight: 600; }
.wf-side .side-links a span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@media (max-width: 900px) {
  .actions-layout { flex-direction: column; align-items: stretch; }
  .wf-side { flex: 1 1 auto; width: 100%; }
}
.run-sub { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.chip .glyph { vertical-align: text-bottom; margin-right: 2px; }
.dispatch-body { padding: 16px; }
.run-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.run-title { display: flex; align-items: center; gap: 10px; min-width: 0; }
.run-title h2 { margin: 0; }
.run-meta { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin: 6px 0 16px; }
.run-actor { display: inline-flex; align-items: center; gap: 4px; }
.run-body { display: flex; gap: 20px; align-items: flex-start; }
.job-list { flex: 0 0 240px; display: flex; flex-direction: column; gap: 2px; }
.job-item { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: var(--radius); color: var(--fg); }
.job-item:hover { background: var(--surface); text-decoration: none; }
.job-item.current { background: var(--surface); font-weight: 600; }
.job-item > span:first-of-type { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.job-detail { flex: 1; min-width: 0; }
.job-head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.job-head .raw-log-link { margin-left: auto; }
/* The steps of a job: a stack of foldables divided by hairlines, with the
   first carrying the section's own rule. */
.step { border-top: 1px solid var(--border-soft); }
.step:first-of-type { border-top: 2px solid var(--border); }
.step > summary { display: flex; align-items: center; gap: 8px; padding: 8px 12px; cursor: pointer; }
.step > summary:hover { background: var(--surface); }
.step > summary .step-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.joblog { background: var(--code-bg); color: var(--fg); font-family: var(--font-mono); font-size: 12px; line-height: 1.5; padding: 10px 12px; margin: 0; overflow-x: auto; white-space: pre-wrap; word-break: break-word; }
/* SGR colours from job output (src/ansi.ts). The sixteen ANSI tokens belong to
   the theme like every other colour here, so a dark theme brightens them and a
   light one darkens them. */
.joblog .a-b { font-weight: 600; }
.joblog .a-d { opacity: 0.65; }
.joblog .a-i { font-style: italic; }
.joblog .a-u { text-decoration: underline; }
.joblog .a-blk { color: var(--ansi-black); } .joblog .a-bblk { color: var(--ansi-bright-black); }
.joblog .a-red { color: var(--ansi-red); } .joblog .a-bred { color: var(--ansi-bright-red); }
.joblog .a-grn { color: var(--ansi-green); } .joblog .a-bgrn { color: var(--ansi-bright-green); }
.joblog .a-yel { color: var(--ansi-yellow); } .joblog .a-byel { color: var(--ansi-bright-yellow); }
.joblog .a-blu { color: var(--ansi-blue); } .joblog .a-bblu { color: var(--ansi-bright-blue); }
.joblog .a-mag { color: var(--ansi-magenta); } .joblog .a-bmag { color: var(--ansi-bright-magenta); }
.joblog .a-cyn { color: var(--ansi-cyan); } .joblog .a-bcyn { color: var(--ansi-bright-cyan); }
.joblog .a-wht { color: var(--ansi-white); } .joblog .a-bwht { color: var(--ansi-bright-white); }
.step .joblog { border-top: 1px solid var(--border); }
.joblog.live { border-top: 2px solid var(--border); max-height: 70vh; overflow-y: auto; }
@media (max-width: 700px) {
  .run-body { flex-direction: column; align-items: stretch; }
  .job-list { flex: 1 1 auto; width: 100%; }
}

.artifacts { margin-top: 20px; max-width: 620px; }
.artifacts .box-body { display: flex; flex-direction: column; gap: 6px; }
.artifacts a.artifact { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--radius); color: var(--fg); }
.artifacts a.artifact:hover { background: var(--surface); text-decoration: none; }
.artifacts p { margin: 4px 0 0; }

/* --- history: a commit row carries actions on its right --- */
.commit-main .title { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.commit-actions { display: flex; align-items: center; gap: 6px; flex: none; }
.commit-actions .btn { padding: 4px 8px; }

/* --- blame: the file view with a commit column down its left --- */
.blame {
  background: var(--code-bg); overflow-x: auto;
  font-family: var(--font-mono); font-size: 12px; line-height: 20px;
}
.blame-row { display: flex; width: max-content; min-width: 100%; }
.blame-row:target { background: var(--line-mark); }
/* A run of lines from one commit reads as a block, so only its first row
   names the commit and only its first row carries the rule above it. */
.blame-row.blame-start { border-top: 1px solid var(--border-soft); }
.blame-row:first-child { border-top: none; }
.blame-commit {
  position: sticky; left: 0; z-index: 1; flex: none; display: flex; align-items: center; gap: 6px;
  width: 320px; padding: 0 10px; overflow: hidden; background: var(--surface);
  border-right: 1px solid var(--border); font-family: var(--font-ui);
}
.blame-subject { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg); font-size: 12px; }
.blame-when { flex: none; white-space: nowrap; }
.blame-when time { color: inherit; }
.blame-prior { flex: none; display: flex; color: var(--fg-subtle); }
.blame-prior:hover { color: var(--accent); }
/* The commit column and the numbers both stay put while the code scrolls
   under them, so the number sits at exactly the column's width. */
.blame .lnum { left: 320px; }
@media (max-width: 700px) {
  .blame-commit { width: 180px; }
  .blame .lnum { left: 180px; }
  .blame-when { display: none; }
}

/* --- diffs: the numbers down each side, and the shape of the change. These
   rules come after the base .dline and .diff-file-header ones and refine
   them, rather than editing them in place. --- */
.diff-summary { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.stat-add { color: var(--alert-tip); font-weight: 600; font-size: 12px; }
.stat-del { color: var(--danger); font-weight: 600; font-size: 12px; margin-left: 6px; }
/* One bar in the proportion of the change, drawn at the weight of a rule
   rather than as a row of counters: the added share, then the removed. */
.statbar { display: inline-flex; width: 44px; height: 3px; margin-left: 10px; background: var(--chip-bg); }
.statbar span { display: block; height: 100%; }
.statbar .add { background: var(--alert-tip); }
.statbar .del { background: var(--danger); }
details.diff-file > summary.diff-file-header {
  display: flex; align-items: center; gap: 8px; cursor: pointer; list-style: none; font-family: var(--font-ui);
}
details.diff-file > summary::-webkit-details-marker { display: none; }
.diff-file-header .fold { color: var(--fg-muted); transition: transform 0.1s; }
details.diff-file:not([open]) .fold { transform: rotate(-90deg); }
details.diff-file:not([open]) > summary.diff-file-header { border-bottom: none; }
.diff-path { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.diff-file-stat { flex: none; display: flex; align-items: center; }
.diff-none { padding: 16px; }
.dline { display: flex; padding: 0; width: max-content; min-width: 100%; }
/* The numbers stay put while a long line scrolls under them; inheriting the
   background keeps an added or removed line's colour behind its number. */
.dnum {
  position: sticky; flex: none; width: 44px; padding: 0 6px; text-align: right;
  color: var(--fg-subtle); user-select: none; background: inherit;
}
.dline .dnum:first-child { left: 0; }
.dline .dnum:nth-child(2) { left: 44px; box-shadow: 1px 0 0 var(--border-soft); }
.dtext { white-space: pre; padding: 0 10px; flex: 1 1 auto; }
@media (max-width: 700px) {
  .dnum { width: 34px; }
  .dline .dnum:nth-child(2) { left: 34px; }
}

/* --- Languages: the share bar in the About panel. Each segment's colour is
   inline rather than here, because a language's colour belongs to the language
   (it is Linguist's) and not to the theme; the table in languages.ts is where
   they live. Only the shape is this file's business. --- */
.lang-bar { display: flex; height: 6px; overflow: hidden; background: var(--border-soft); margin-bottom: 12px; }
.lang-seg { display: block; height: 100%; }
.lang-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.lang-list li { display: flex; align-items: center; gap: 8px; font-size: 13px; }
/* The square from the mark, at the size of a bullet. */
.lang-dot { flex: none; width: 9px; height: 9px; }
.lang-name { font-weight: 600; }
.lang-pct { margin-left: auto; }

/* --- search: the box in the repository header, and the results --- */
.repo-search { margin-left: auto; }
.search-form { position: relative; display: flex; align-items: center; }
.repo-search, .search-form { position: relative; }
.search-input {
  width: 260px; max-width: 100%; padding: 5px 10px 5px 30px; font-size: 13px; font-family: inherit;
  border: 1px solid var(--border); border-radius: var(--radius); background: var(--input-bg); color: var(--fg);
}
.search-form .search-input { width: 360px; }
.search-glyph { position: absolute; left: 8px; top: 50%; margin-top: -8px; color: var(--fg-muted); pointer-events: none; }
.search-file { margin-top: 16px; }
.search-file .box-header a { font-family: var(--font-mono); font-size: 12px; }
.search-hits { background: var(--code-bg); overflow-x: auto; }
.search-hit {
  display: flex; gap: 12px; padding: 2px 12px; color: var(--fg);
  font-family: var(--font-mono); font-size: 12px; line-height: 20px;
}
.search-hit:hover { background: var(--surface); text-decoration: none; }
.search-hit .lnum { flex: none; width: 44px; text-align: right; color: var(--fg-subtle); position: static; }
.search-hit .ltext { white-space: pre; padding: 0; }
.search-hit mark { background: var(--line-mark); color: inherit; font-weight: 600; }
.search-more { display: block; padding: 6px 12px; font-size: 12px; border-top: 1px solid var(--border-soft); }
@media (max-width: 860px) {
  .repo-search { display: none; }
  .search-form .search-input { width: 100%; }
}

/* --- comparing two revisions --- */
.cmp-form { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 16px; }
.cmp-picker { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--fg-muted); }
.cmp-picker select { width: auto; max-width: 220px; padding: 4px 8px; font-size: 13px; }
.cmp-status { border-left: 3px solid var(--border); padding: 4px 0 4px 14px; margin-bottom: 16px; }
.cmp-commits { margin-bottom: 20px; }

/* --- contributors, and a filter the reader can take off --- */
.contributors { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.contributor { display: inline-flex; }
.contributor:hover { text-decoration: none; opacity: 0.85; }
.filter-chip {
  display: inline-flex; align-items: center; gap: 6px; padding: 2px 8px; font-size: 12px;
  border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); color: var(--fg);
}
.filter-chip .glyph { color: var(--fg-muted); }
.filter-chip a { display: inline-flex; color: var(--fg-muted); }
.filter-chip a:hover { color: var(--danger); }

/* --- issues: the list, one issue and its thread --- */
.state-filter { display: flex; gap: 4px; flex-wrap: wrap; }
.state-tab { display: inline-flex; align-items: center; gap: 6px; padding: 5px 10px; border-radius: var(--radius); color: var(--fg-muted); font-size: 13px; }
.state-tab:hover { background: var(--surface); text-decoration: none; }
.state-tab.current { color: var(--fg); font-weight: 600; }
.state-tab .glyph { color: var(--fg-muted); }
/* The three states of a thread, in three colours the rest of the sheet
   already uses for the same three meanings. Open takes the vault's accent,
   which is what everything live and current is drawn in, so a vault's own
   colour is what its open work is marked by. Merged takes the green a
   passing run takes, because it is the same news: the thing landed. Closed
   takes the muted grey, because a closed thread is over and should recede
   rather than compete with the open ones beside it. */
.glyph.issue-open { color: var(--accent); }
.glyph.issue-closed { color: var(--fg-muted); }
table.listing.issues td.issue-cell { display: flex; align-items: flex-start; gap: 10px; }
table.listing.issues td.issue-cell > span { min-width: 0; }
.issue-link { color: var(--fg); font-weight: 600; }
.issue-link:hover { color: var(--accent); text-decoration: none; }
.chip.label { margin-left: 6px; }
.issue-comments { display: inline-flex; align-items: center; gap: 4px; color: var(--fg-muted); }
.issue-comments:hover { color: var(--accent); text-decoration: none; }

.issue-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.issue-title { font-size: 24px; margin: 0 0 8px; }
.issue-sub {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding-bottom: 12px; border-bottom: 1px solid var(--border); margin-bottom: 20px;
}
.state-badge {
  display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: var(--radius);
  font-size: 13px; font-weight: 600; color: var(--on-primary); background: var(--accent);
}
.state-badge.closed { background: var(--fg-muted); }
/* A thread is a run of entries, each opening on its own rule with who wrote
   it and when, and the words under that. */
.issue-thread { display: flex; flex-direction: column; gap: 20px; max-width: 880px; }
.issue-comment { border-top: 2px solid var(--border); }
.issue-comment-head {
  display: flex; align-items: center; gap: 8px;
  border-bottom: 1px solid var(--border-soft); padding: 8px 12px;
}
.issue-comment-body { padding: 16px 12px 4px; }
.issue-event { display: flex; align-items: center; gap: 8px; color: var(--fg-muted); font-size: 13px; }
.issue-reply { border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
.issue-reply .issue-comment-head { border-bottom: 1px solid var(--border); padding: 8px 12px; }
.issue-reply textarea { border: none; border-radius: 0; }
.issue-reply .actions { padding: 10px 12px; justify-content: flex-end; border-top: 1px solid var(--border); }

/* --- the markdown editor: Write and Preview tabs over the field, and a
   toolbar that writes markdown into it. The tabs read as file tabs into the
   writing surface, which is why the current one shares its background and
   sits on the head's border. --- */
.md-editor { border: 1px solid var(--border); border-radius: var(--radius); background: var(--input-bg); }
.md-editor:focus-within { outline: 2px solid var(--focus); border-color: var(--accent); }
.md-head {
  display: flex; align-items: flex-end; justify-content: space-between; gap: 8px; flex-wrap: wrap;
  padding: 6px 8px 0; background: var(--surface); border-bottom: 1px solid var(--border);
  border-radius: var(--radius) var(--radius) 0 0;
}
.md-tabs { display: flex; gap: 2px; }
.md-tab {
  border: 1px solid transparent; border-bottom: none; background: none; padding: 6px 12px;
  font: inherit; font-size: 13px; color: var(--fg-muted); cursor: pointer;
  border-radius: var(--radius) var(--radius) 0 0; margin-bottom: -1px;
}
.md-tab:hover { color: var(--fg); }
.md-tab.current { background: var(--input-bg); border-color: var(--border); color: var(--fg); font-weight: 600; }
.md-toolbar { display: flex; align-items: center; gap: 8px; padding-bottom: 6px; flex-wrap: wrap; }
.md-group { display: flex; }
.md-group + .md-group { border-left: 1px solid var(--border); padding-left: 8px; }
.md-btn {
  display: inline-flex; align-items: center; justify-content: center; border: none; background: none;
  padding: 4px 5px; border-radius: var(--radius); color: var(--fg-muted); cursor: pointer;
}
.md-btn:hover { background: var(--surface-hover); color: var(--fg); }
/* Previewing: the buttons would edit a field that is not on screen. */
.md-editor.previewing .md-toolbar { visibility: hidden; }
.md-editor textarea { border: none; border-radius: 0 0 var(--radius) var(--radius); display: block; }
.md-editor textarea[hidden] { display: none; }
.md-editor textarea:focus { outline: none; }
.md-render { padding: 12px; overflow-x: auto; }
/* Inside a reply card the editor sits borderless: the card is the border. */
.issue-reply .md-editor, .issue-reply .md-editor:focus-within { border: none; outline: none; border-radius: 0; }
.issue-reply .md-head { border-radius: 0; }

/* --- releases: notes attached to a tag --- */
.release { display: flex; gap: 24px; align-items: flex-start; padding: 20px 0; border-top: 1px solid var(--border-soft); }
.release:first-of-type { border-top: none; }
.release-side { flex: 0 0 200px; display: flex; flex-direction: column; align-items: flex-start; gap: 6px; }
.release-tag { display: inline-flex; align-items: center; gap: 6px; color: var(--fg); font-size: 15px; }
.release-tag .glyph { color: var(--fg-muted); }
.release-main { flex: 1 1 auto; min-width: 0; }
.release-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.release-head h2 { margin: 0; }
.release-head h2 a { color: var(--fg); }
.release-actions { margin-left: auto; }
.chip-latest { background: var(--primary); color: var(--on-primary); font-weight: 600; }
.chip-pre { background: transparent; border: 1px solid var(--alert-warning); color: var(--alert-warning); }
.release-notes { margin: 12px 0 16px; }
.release-downloads { display: flex; flex-direction: column; gap: 6px; max-width: 320px; }
.release-download { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border: 1px solid var(--border); border-radius: var(--radius); color: var(--fg); font-size: 13px; }
.release-download:hover { background: var(--surface); text-decoration: none; }
.release-download .glyph { color: var(--fg-muted); }
@media (max-width: 860px) {
  .release { flex-direction: column; align-items: stretch; gap: var(--s2); }
  .release-side { flex: 1 1 auto; flex-direction: row; align-items: center; }
}

/* --- forks --- */
.fork-note { display: flex; align-items: center; gap: 6px; margin: -4px 0 8px 24px; }
.fork-note .glyph { color: var(--fg-subtle); }

/* --- the commit box's branch choice --- */
.commit-target { border-top: 1px solid var(--border); margin-top: 10px; padding-top: 10px; }
.commit-target .field { margin: 8px 0 4px; }
.commit-target p { margin: 0; }

/* --- pull requests: the merge box, and the branch pair. The merge box is
   the page's one piece of news, so it is drawn the way the sheet draws news:
   a rule down the side it is read from, in the colour of what it says. --- */
.cmp-status { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.state-badge.merged { background: var(--alert-tip); color: var(--on-primary); }
.pull-merged { color: var(--alert-tip); }
.merge-box {
  display: flex; align-items: flex-start; gap: 12px; margin: 20px 0;
  border-left: 3px solid var(--border); padding: 6px 0 6px 14px;
}
.merge-box > .glyph { margin-top: 2px; }
.merge-box form { margin-left: auto; }
.merge-do { display: flex; align-items: center; gap: 8px; }
.merge-method select { width: auto; padding: 4px 8px; font-size: 13px; }
.merge-box.clean { border-left-color: var(--alert-tip); }
.merge-box.clean > .glyph { color: var(--alert-tip); }
.merge-box.conflict { border-left-color: var(--danger); }
.merge-box.conflict > .glyph { color: var(--danger); }
.merge-box.merged { border-left-color: var(--alert-tip); }
.merge-box.merged > .glyph { color: var(--alert-tip); }
.merge-box.closed > .glyph, .merge-box.unknown > .glyph { color: var(--fg-muted); }
.merge-conflicts { margin: 6px 0 0; padding-left: 18px; font-size: 12px; color: var(--fg-muted); }
.pull-commits { display: flex; flex-direction: column; }
.pull-commits .commit-row { border: none; border-top: 1px solid var(--border-soft); padding: 8px 0; }
.pull-commits .commit-row:first-child { border-top: none; }
.pull-files { margin: 24px 0 12px; font-size: 16px; }

/* --- narrowing a list of issues --- */
.issue-filters { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
.issue-search { position: relative; }
.issue-search .search-input { width: 320px; max-width: 100%; }
/* A label chip is a link when it narrows the list, and keeps its own colour
   rather than the link colour. */
a.chip.label:hover { text-decoration: none; filter: brightness(1.1); }
.issue-filters .dropdown-menu { width: 260px; }
.issue-filters .dd-item .muted { margin-left: auto; }
@media (max-width: 700px) {
  .issue-search .search-input { width: 100%; }
  .issue-filters { flex-direction: column; align-items: stretch; }
}

/* --- the repository listing ---

   The front page and a collection's page are the same list: every repository
   the reader can see, one card each. A name set against the far edge of a wide
   page with a thousand pixels of nothing between it and its date is a name the
   eye has to hunt for, so a card is capped at a readable width and the page's
   spare room is spent on a second column rather than on stretching the first.
   Three columns is where the cards get too narrow for a description, so two is
   as far as it goes. */
.listing-controls {
  display: flex;
  align-items: center;
  gap: var(--s3);
  margin-bottom: var(--s4);
  flex-wrap: wrap;
}
.listing-controls .list-filter { flex: 1 1 240px; max-width: 360px; }
.listing-controls .seg { margin-left: auto; }

.repo-grid {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: 1fr;
  gap: 1px;
  background: var(--border-soft);
  border-block: 1px solid var(--border-soft);
}
@media (min-width: 900px) {
  .repo-grid { grid-template-columns: 1fr 1fr; }
}
.repo-card {
  background: var(--bg);
  padding: var(--s3) var(--s4) var(--s3) 0;
  min-width: 0;
  /* The card highlights on hover, so the whole card is the target that
     promises: the name's link is stretched over it, and the two marks that
     lead somewhere else are lifted back above it. */
  position: relative;
}
@media (min-width: 900px) {
  /* The gap between the two columns is a hairline of the grid's own
     background, so the right column gets the padding the gap would have been. */
  .repo-card:nth-child(even) { padding-left: var(--s4); }
}
.repo-card:hover { background: var(--surface); }
.rc-top { display: flex; align-items: baseline; gap: var(--s2); }
.rc-name {
  font-weight: 600;
  font-size: var(--t-base);
  min-width: 0;
  /* One line however long the name is: a name that would wrap is cut with an
     ellipsis, so no card is ever taller than its neighbours because of it. */
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.rc-name::after { content: ''; position: absolute; inset: 0; }
/* The collection stays whole, so a narrow column breaks the name at the slash
   rather than in the middle of the collection's own word. */
.rc-collection { color: var(--fg-subtle); font-weight: 400; white-space: nowrap; }
.rc-marks {
  display: inline-flex;
  align-items: center;
  gap: var(--s2);
  margin-left: auto;
  flex: none;
  position: relative;
}
.rc-desc {
  margin: 2px 0 0;
  color: var(--fg-muted);
  font-size: var(--t-sm);
  line-height: 1.45;
  /* Two lines, so a long description cannot make one card twice the height of
     its neighbour and break the rhythm of the column. */
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.rc-meta { margin-top: var(--s2); color: var(--fg-subtle); font-size: var(--t-xs); }

/* --- topics ---

   One look everywhere on purpose: a topic is the same topic on a card, in the
   About panel, and on its own page, so it wears the accent in a rounded pill
   rather than a colour of its own the way an issue label does. The tinted
   background is mixed from the accent so every theme keeps its own hue; the
   plain chip background underneath is the fallback for a browser without
   color-mix. */
.topic-chips { display: inline-flex; flex-wrap: wrap; gap: 4px; }
.chip.topic { background: var(--chip-bg); color: var(--accent); border-radius: 999px; font-weight: 500; }
.chip.topic { background: color-mix(in srgb, var(--accent) 11%, transparent); }
a.chip.topic:hover { background: color-mix(in srgb, var(--accent) 20%, transparent); text-decoration: none; }
.rc-topics { margin-top: var(--s2); }
.side-topics { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; margin: 0 0 12px; }
/* The editor behind the chips: a summary dressed as one more chip, opening
   the same popover the other menus use. */
.topic-edit { display: inline-block; }
.topic-add { display: inline-flex; align-items: center; gap: 4px; border-radius: 999px; padding: 1px 7px; font-size: 12px; background: var(--chip-bg); color: var(--fg-muted); }
.topic-add:hover { color: var(--fg); }
.topic-add .glyph { margin: 0; }
.topic-edit-menu { padding: 10px 12px; width: 300px; }
.topic-edit-menu label { display: block; margin-bottom: 4px; }
.topic-edit-menu input[type="text"] { width: 100%; }
.topic-edit-menu p { margin: 6px 0; }
.topic-edit-menu .btn { margin-top: 2px; }
/* The vault-wide index: each topic once, with how many repositories carry it. */
.topic-index { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--s2); }
.topic-index li { display: flex; align-items: center; gap: 10px; }
.topic-title { display: flex; align-items: center; gap: 8px; }
.topic-title .glyph { color: var(--fg-muted); }

.site-link, .ci-mark { display: inline-flex; color: var(--fg-subtle); }
.site-link:hover, .ci-mark:hover { color: var(--accent); }
.ci-success { color: var(--primary); }
.ci-failure { color: var(--danger); }
.ci-running { color: var(--alert-warning); }

/* Which collection a repository is in, when the vault has more than one. */
.collection-chips { display: flex; flex-wrap: wrap; gap: var(--s2); margin-bottom: var(--s5); }
.coll-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
  font-size: var(--t-sm);
  color: var(--fg);
  min-height: var(--touch);
}
.coll-chip:hover { background: var(--surface-hover); text-decoration: none; }
.coll-count { color: var(--fg-subtle); font-variant-numeric: tabular-nums; }

.lede { margin: calc(-1 * var(--s3)) 0 var(--s4); color: var(--fg-muted); font-size: var(--t-sm); }
.lede a.muted { color: var(--fg-muted); text-decoration: underline; }
.vault-note { margin-top: var(--s5); }

/* /about: prose, so a measure rather than the full container. */
.about-page { max-width: 720px; }
.about-page h2 { margin-top: var(--s6); }
.about-page .cmd-row { margin: var(--s3) 0; }

/* A collection's profile README, above its repository listing. A .box takes
   its space from above, and here the listing follows it, so the gap below is
   added rather than inherited. */
.profile-box { margin-bottom: var(--s6); }
.profile-hint { margin: 0 0 var(--s5); }

/* A username linked to its profile page. It keeps the colour and weight of
   the text around it, so a linked name reads exactly as an unlinked one and
   only hover says it goes somewhere; the flex is for the identicon some
   carry. */
.user-link { display: inline-flex; align-items: center; gap: 6px; color: inherit; }
.user-link:hover { color: var(--accent); text-decoration: underline; }

/* The user behind a namespace collection, on their page at /<username>: the
   username beside the chosen name, then the bio and links under the heading,
   above the profile README and the repositories. */
.profile-username { color: var(--fg-muted); font-weight: 400; font-size: var(--t-lg); }
.profile-bio { margin: calc(-1 * var(--s3)) 0 var(--s4); max-width: 720px; }
.profile-links { display: flex; flex-wrap: wrap; gap: 4px 16px; margin: calc(-1 * var(--s3)) 0 var(--s4); font-size: var(--t-sm); }
.profile-links a { display: inline-flex; align-items: center; gap: 4px; color: var(--fg-muted); }
.profile-links a:hover { color: var(--accent); }
.profile-links .icon { margin-right: 0; }

/* --- what a finger has to hit ---

   Under a coarse pointer every control grows to --touch, which is the one
   number that changes. Nothing is re-laid-out and nothing moves: the rows and
   buttons that were comfortable for a mouse simply become large enough to be
   hit by a thumb. */
@media (pointer: coarse) {
  .btn, .copy-btn, .seg a, .state-tab, .filter-chip, .list-filter { min-height: var(--touch); }
  .dd-item, .find-item, .job-item, .wf-side .side-links a, .admin-side .side-links a {
    min-height: var(--touch);
  }
  table.listing td { padding-top: 10px; padding-bottom: 10px; }
  .side-links a { min-height: 32px; }
  .tab { padding-top: var(--s3); padding-bottom: 18px; }
  .lnum { width: 44px; }
}

/* --- the narrow screen ---

   The interface is one column from the start, so a phone needs the spacing
   loosened and two or three things told to stop insisting on a width, rather
   than a second layout of its own. */
@media (max-width: 700px) {
  main { padding: var(--s4) var(--s3) var(--s6); }
  .container { padding: 0 var(--s3); }
  /* The bar is on every screen of every page, so it gives back what it can. */
  .topbar .container { height: 46px; gap: var(--s2); }
  h1 { font-size: 22px; }
  .repo-title { font-size: var(--t-lg); }
  /* Tighter tabs so more of the row is reachable without scrolling it. */
  .tab { padding-left: var(--s2); padding-right: var(--s2); gap: 6px; }
  /* A button in a wrapped row of them is easier to aim at when the row shares
     the width out evenly than when each is as wide as its own label. */
  .toolbar .right-group .btn, .toolbar .right-group .dropdown { flex: 1 1 auto; }
  .toolbar .right-group .dropdown > summary { width: 100%; }
  .form-box { padding: var(--s4); }
  /* A row of label-and-field pairs has to become a column here, or the pairs
     wrap where they like and a label ends up above somebody else's field. */
  .inline-form { flex-direction: column; align-items: stretch; }
  .inline-form label { margin-top: var(--s1); }
  .inline-form input[type="text"], .inline-form select { width: 100%; }
  .inline-form label.checkbox, .inline-form label:has(input) { margin-top: 0; }
  .empty-state { padding: var(--s6) var(--s3); }
  /* A row that reads "the file, and what you can do with it" becomes two rows
     rather than a squeeze, and the numbers down the left of a file give back
     the width they do not need. */
  .code-meta { flex-direction: column; align-items: stretch; gap: var(--s2); }
  .code-meta .right-group .btn, .code-meta .right-group .seg { flex: 1 1 auto; }
  .lnum { width: 40px; padding-left: var(--s1); }
  .blame .lnum { width: 40px; }
  .issue-title { font-size: var(--t-xl); }
  .release-side { flex-wrap: wrap; }
  /* The panel under the listing keeps its rules but loses the indent, since
     there is no listing beside it to line up with. */
  .repo-side .side-block:first-child { padding-top: var(--s3); }
}
@media (max-width: 480px) {
  /* A wrapped row of buttons on a phone lands wherever the widths happen to
     fall. Two even columns is a shape the reader can predict, and an odd last
     button takes the whole row rather than sitting half-width beside nothing. */
  .toolbar .right-group, .code-meta .right-group {
    display: grid; grid-template-columns: 1fr 1fr; gap: var(--s2); width: 100%;
  }
  .toolbar .right-group > *, .code-meta .right-group > * { width: 100%; }
  .toolbar .right-group > .dropdown > summary, .code-meta .right-group > .dropdown > summary { width: 100%; }
  .toolbar .right-group > *:last-child:nth-child(odd),
  .code-meta .right-group > *:last-child:nth-child(odd) { grid-column: 1 / -1; }
  /* At this width the date beside a name is worth less than the room it
     takes, so the roster's two columns become two lines. */
  table.listing.roster tr { display: block; }
  table.listing.roster td { display: block; border-top: none; padding: 2px var(--s3); }
  table.listing.roster tr:first-child td:first-child { padding-top: var(--s2); }
  table.listing.roster td:first-child { padding-top: var(--s2); border-top: 1px solid var(--border-soft); }
  table.listing.roster tr:first-child td:first-child { border-top: none; }
  table.listing.roster td.right { width: auto; text-align: left; padding-bottom: var(--s2); }
}
.side-block hr.rule { margin: var(--s3) 0; }
`;
