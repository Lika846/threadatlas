# React Flow checklist (ThreadAtlas)

ThreadAtlas's own checklist for the map (`@xyflow/react` 12). Not part of Vercel's guidelines.
Check the code, and where possible the running page, for each item.

## Keyboard and screen readers

- The map has an accessible name and a short description of how to use it
  (`ariaLabelConfig` or a labelled region), and says how many groups and items it shows.
- Nodes are reachable with Tab (`nodesFocusable`), have a meaningful `ariaLabel` (the group or
  conversation title, not an id), and show a visible focus ring in light and dark.
- Enter or Space on a focused node does the same as a click (open the group or conversation).
- Arrow-key movement of nodes (`disableKeyboardA11y` off) does not trap or confuse; if nodes
  aren't meant to move, `nodesDraggable` is off so arrows don't move them by accident.
- The pane can be zoomed and panned without a mouse (Controls buttons, or keys), and the
  Controls buttons have labels.
- Every fact on the map is also available outside the canvas: an equivalent list or table that
  works with a screen reader, linked from the map.
- Focus is not lost when the view changes (switching tabs, opening a group, Back).

## Layout and responsiveness

- The canvas has an explicit height at every width; nothing overflows horizontally at 375 px.
- On small screens the list (not the canvas) is the default or easy to reach; touch panning
  doesn't trap page scrolling.
- Labels stay readable when zoomed out: truncation with the full title available, no
  overlapping text at the default `fitView`.
- Colours used for groups meet contrast in both themes and aren't the only cue.

## State and scale

- The selected group, view (tab) and zoom target are in the URL, so Back and reload restore them.
- Rendering stays responsive at about 3,000 conversations: measure first render and
  interaction; `onlyRenderVisibleElements` or aggregation if needed.
- `prefers-reduced-motion` turns off animated `fitView`/zoom transitions.
- Empty, not-indexed and indexing-in-progress states explain what to do next.
