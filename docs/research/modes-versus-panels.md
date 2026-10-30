# Modes versus docked panels: UX evidence for Oxide's window template

**Ticket:** [#269](https://github.com/cavallinilorenzo/oxide/issues/269) (map [#267](https://github.com/cavallinilorenzo/oxide/issues/267))  
**Research date:** 2026-10-30

## Scope

What UX research and platform guidance say about modes versus docked panels in a multi-tool workspace, and which principles should judge the skeleton prototypes for Oxide's main window. "Mode" here means the header's Chat / Terminal / Code Work mode switch, which swaps the central view; "panel" means a Surface docked right or bottom (Files, Diff, Pull request, Issues, Terminal) or the sidebar. Vocabulary follows [GLOSSARY.md](../../GLOSSARY.md).

Out of scope: visual language, and choosing a layout. This report supplies the yardsticks; the prototype tickets apply them.

## Answer in one paragraph

No study compares Work modes with docked panels in an agentic coding tool, so the answer is assembled from adjacent evidence. The empirical work agrees on three things. Visible cues speed the return to suspended work. Spatially stable layouts speed revisiting. Developers lose a large share of their time re-finding context that their tools hid or moved. Expert opinion (Raskin, Tesler, NN/g) adds that modes cause errors when the active one sits outside the user's attention, and that modes are acceptable when they are visible where the user looks. Platform guides (Apple, Microsoft, GNOME) reserve view switchers for a few peer views that aren't used together, and use panes for supplementary information beside the main view. For Oxide: keep Thread status and Approvals outside any mode, and give every tool one stable place. Anything used together belongs side by side, not behind a switch. A Work mode is defensible only for a view that takes full attention and is rarely needed beside another, and it must keep its state and identify itself at the input. This does not settle whether the three requested Work modes survive (PRODUCT.md "Workflows"); it sets the conditions each must meet.

## Principles and tests

Each principle names its strongest source and the kind of support: **E** for empirical (a measured study) and **O** for opinion or guidance (expert judgment, platform convention). The tests are written to be checked against a clickable prototype at Oxide's minimum window size (900×560) and at a common laptop size (1440×900), using realistic content: three or more Threads, one of them with a running Turn and another with a pending Approval.

| # | Principle | Support | Test a prototype must pass |
|---|---|---|---|
| 1 | **Thread status is ambient.** Whether any Thread needs input is visible from every view, not inside a mode. | E: Iqbal & Horvitz 2007; Ko et al. 2006. O: NN/g heuristic 1 | With Thread B holding a pending Approval while the user works in Thread A, in each Work mode, with any Surface open and the Thread Board closed: B's needs-input state is visible with **zero** clicks, scrolls or hovers, and B's Approval is reachable in **one** action (click or shortcut). Holds at 900×560. |
| 2 | **Signal, don't seize.** A Thread changing status announces itself but never moves focus or the view. | E: Iqbal & Horvitz 2007. O: Raskin (locus of attention) | While the user types in the Code editor or the Terminal, another Thread enters needs input or completes: the caret, the active Work mode, the selected Thread and the open Surfaces stay put, and no modal appears; every keystroke lands where it was aimed. |
| 3 | **Switching keeps the working set.** Leaving and returning to a view restores it exactly. | E: Ko et al. 2006; Parnin & Rugaber 2011 | In Code with three files open (one unsaved, caret mid-file), a long command running in the Terminal and the Diff scrolled to a hunk: switch Work mode, then switch Thread, then come back. The same files, tab order, caret, scroll positions, unsaved edits and live command output are all there, with nothing reopened or re-run. |
| 4 | **Each tool has one stable home.** A tool always appears in the same region, and showing or hiding one doesn't move the others. | E: Scarr et al. 2012; Gutwin et al. 2020; Findlater & McGrenere 2004. O: Raskin (habituation) | For each of Terminal, Files, Diff, Pull request, Issues, Code and the Thread Board, record where it opens, starting from every Work mode. Each opens in **one** region every time. Toggling any Surface leaves the header controls, the sidebar's Thread rows and the composer where they were. If a tool can appear in two places (today the bottom Terminal and Terminal Work mode), it's the same instance and says so. |
| 5 | **What is used together is shown together.** Information needed at the same moment sits side by side, not behind a switch. | E: Kandogan & Shneiderman 1997; Bly & Rosenberg 1986; Ko et al. 2006; Bragdon et al. 2010. O: Apple HIG split views; GNOME utility panes | Each co-use pair is visible at once, without overlays, at 1440×900, and at 900×560 with at most one other region collapsed: (a) a Thread's Transcript and its Turn's Diff; (b) a pending Approval and the command or file change it asks about; (c) a Thread and the Terminal output of the command it ran; (d) a file in Code and its Diff hunk. **A single switcher that toggles between two members of a pair fails.** |
| 6 | **If a mode stays, it announces itself where the eyes are.** The input that receives keystrokes states what Enter will do, and shortcuts keep one meaning. | E: Sellen et al. 1992. O: Tesler 2012; Raskin 2000; NN/g "Modes" | (a) A screenshot cropped to the focused input alone shows whether Enter sends a prompt to a Provider or runs a shell command (for example Provider and Model on one, shell and directory on the other). (b) The active Work mode has at least two cues, one of them inside the central area rather than only in the header. (c) Each global shortcut (Ctrl+N, Ctrl+W, Ctrl+F, Ctrl+B) does the same thing in every Work mode, or is visibly unavailable. |
| 7 | **Switchers for peer views; toggles for panes.** Use a view switcher only for a few mutually exclusive views of equal rank; panes get independent show/hide controls. | O: Apple HIG segmented controls and sidebars; GNOME view switchers; Microsoft navigation basics | Every control in the header can be classified as either "switch the main view" (single choice among 3 to 5 peers, none needed beside another, per principle 5) or "show/hide a pane" (independent, several can be on at once). No control mixes the two, and no "view" in a switcher appears in a co-use pair. |
| 8 | **Disclose progressively, never invisibly.** What is frequent stays visible; what collapses leaves a visible handle and a shortcut, in a stated order. | O: NN/g progressive disclosure; Apple HIG split views and sidebars; Microsoft NavigationView; GNOME utility panes | At 900×560: every collapsed region shows a visible affordance **and** has a keyboard shortcut that restores it; the central area keeps its minimum usable width; the collapse order is written down, and the indicator from principle 1 is never among the first things to go. |

### How the principles interact

Principles 5 and 7 together give a single sharp check of any Work mode. List the views the user needs at the same moment. A Work mode that puts two of them behind one switch fails. A Work mode whose views never need each other passes, provided principles 1, 3 and 6 hold. The research doesn't say which of Chat, Terminal and Code are co-used. Observing the prototypes with real tasks answers that, and it is the question the deciders need answered.

## Findings by topic

### Modes and mode errors

- **Definitions.** Tesler (1981, quoted in his 2012 history) defined a mode as "a state of the user interface that lasts for a period of time, is not associated with any particular object, and has no role other than to place an interpretation on operator input." Raskin's *The Humane Interface* (2000) makes modality relative to attention: an interface is modal for a gesture when the state that sets the gesture's meaning isn't the user's locus of attention. The Raskin Center's summary of his principles states the guideline: "eliminate all modes. If a mode cannot be eliminated, convert it to a quasimode" (a mode held only while the user keeps acting, like Shift). [O]
- **Where modes are acceptable.** Tesler concedes "modes can be good when they support a metaphor like picking up a brush, and when feedback identifying the current mode is displayed where the user is almost certain to be looking." His evidence for modeless editing is empirical: he cites Roberts and Moran (1981), in which experienced users of the modeless Gypsy editor completed a benchmark in about two-thirds the time of NLS users. [E for editors, O for the generalization]
- **Visual feedback helps, but weakly.** Sellen, Kurtenbach and Buxton (1992) measured mode errors in a text editor. Visual feedback (the screen tinted in insert mode) significantly reduced errors but explained only about 4 to 5% of their variance, against 11 to 16% for a held foot pedal. They conclude that "user-maintained mode states prevent mode errors more effectively than system-maintained mode states." A Work mode is a system-maintained, latching mode, the weaker kind. [E]
- **NN/g.** Laubheimer (2019) recommends "at least two visual indicators" for the active mode, clear labels, and avoiding modes where errors are costly. The article presents expert judgment, not new data. [O]
- **Relevance to Oxide.** Work modes swap whole views rather than reinterpret keys, so they are milder than vi-style modes. One overlap is real, though. In Chat the bottom input sends a prompt to a Provider; in Terminal the bottom input runs a shell command. The same gesture (type, then Enter) means different things depending on the header control, and in the baseline the terminal input shows no placeholder once its shell is ready (`web/src/TerminalInput.tsx`). Principle 6 targets this.

### Interruption, hidden state and resumption

- **Visibility speeds the return.** Iqbal and Horvitz (CHI 2007) logged 27 users for two weeks. After email and IM alerts, suspended windows less than 25% visible "took significantly longer to return to" than windows more than 75% visible (t(20)=3.131, p<0.005 for email; t(23)=2.503, p<0.02 for IM). 27% of suspensions lasted more than two hours, and users blamed "the loss of context associated with the task switch." Participants spent about 10 minutes on alert-driven switches and another 10 to 15 before returning to focused work. The design implication they draw is to keep reminder cues of suspended tasks "in a visible area that can be scanned by the user." This is correlational field data. [E]
- **Developers resume slowly.** Parnin and Rugaber (2011) analysed 10,000 recorded sessions of 85 programmers. Only 10% of sessions had coding start within a minute, and only 7% involved no navigation before the first edit. They also review lab work in which removing an environmental cue, even the mouse position, raises resumption lag. [E]
- **Implication.** A Thread with a pending Approval is suspended work that blocks an agent. Hiding its status inside a mode or a closed Board is the "occluded window" condition. Principles 1 and 2.

### Navigation cost in IDEs

- **A third of the time on navigation mechanics.** Ko, Myers, Coblenz and Aung (IEEE TSE 2006) observed the 10 most experienced of 31 Java developers on 70-minute maintenance tasks in Eclipse. Navigation mechanics took on average 19 minutes, "35 percent of the time not spent answering interruptions." Developers kept their task context in "the interactive state of Eclipse's package explorer, file tabs, and scroll bars," lost it when those were reused for another task, and spent an average of 60 seconds recovering it on return. Their proposed fix shows relevant code side by side rather than behind tabs. [E, small sample, older IDE]
- **Half the time foraging.** Piorkowski et al. (CHI 2013) found 9 professional developers spent 50% of debugging time foraging for information. [E, qualitative]
- **Working sets seen at once.** Bragdon et al.'s Code Bubbles (CHI 2010) shows a working set of code fragments concurrently. Their evaluation reports reduced code-understanding time and fewer navigation interactions than Eclipse. [E, author-run]
- **Implication.** Principles 3 and 5: views must keep their state across switches, and things consulted together shouldn't require switching.

### Spatial memory and stable layouts

- **Stable beats adaptive.** Scarr, Cockburn, Gutwin and Bunt (CHI 2012, Best Paper) found CommandMaps, a flat and spatially stable command layout, "significantly faster than both menus and the Ribbon" for experienced users, with no difference for novices. Findlater and McGrenere (CHI 2004, 27 participants) found a static split menu significantly faster than an adaptive one that reordered itself. Gutwin et al. (GI 2020) found a spatially stable layout of 700 items faster for revisitation than pages reordered on each filter change. Scarr, Cockburn and Gutwin's monograph (*Foundations and Trends in HCI*, 2012) reviews the wider literature and argues many interfaces undermine spatial memory by moving items. [E]
- **Implication.** Principle 4. A tool that appears in different regions depending on the active mode, or a list that reorders while the user is reaching for it, works against the fastest retrieval route experienced users have.

### Tiled versus switched

- Kandogan and Shneiderman (CHI 1997) compared Elastic Windows, space-filling tiled windows with group operations, with independent overlapping windows. 12 experienced users were "statistically significantly faster" in the 6- and 12-window conditions for setup, switching and execution, while the 2-window condition showed little difference. Bly and Rosenberg (CHI 1986) found tasks and users for which tiled windows beat overlapping ones; only the abstract was checked here. [E]
- **Implication.** Principle 5. The advantage of seeing several things at once grows with the number of things in play, and Oxide's agentic use (several Threads, their Diffs, their terminals) is the many-window case.

### Platform guidance

- **Apple HIG.** Segmented controls (macOS): "Use a tab view in the main window area — instead of a segmented control — for view switching," and consider segmented controls "to help people switch views in a toolbar or inspector pane." Keynote's toolbar uses one "to let people show and hide various editing panes." On iOS: "For switching between completely separate sections of an app, use a tab bar instead." Split views (macOS): "Consider letting people hide a pane" to give editing more room, and "Provide multiple ways to reveal hidden panes," including a keyboard shortcut. Panes should "persistently highlight the current selection." Sidebars: "Avoid hiding the sidebar by default"; on macOS, "Consider automatically hiding and revealing a sidebar when its container window resizes," and "Avoid putting critical information or actions at the bottom of a sidebar." For visionOS, prefer a split view for supplementary information because it gives access "without leaving the current context." [O]
- **Microsoft (Windows App SDK).** Navigation basics: consistency, simplicity and clarity. A flat structure suits pages that "can be viewed in any order" and "are clearly distinct from each other," fewer than 8. Avoid "pogo-sticking." Tabs suit documents users open, close and rearrange. SplitView's Inline mode keeps a pane "always visible" sharing space with content, while Overlay hides it until opened. NavigationView's default adaptive behavior shows a full pane at 1008 px and wider, and an icon-only compact pane from 641 to 1007 px. Oxide's 900 px minimum falls in that compact band. [O]
- **GNOME HIG.** View switchers switch "between a small number of predefined views," three to five as a rule of thumb, and views shouldn't have controls that affect other views because "Users are unlikely to discover such dependencies." Utility panes "display additional controls, locations or information alongside the main window view"; a pane that "is subordinate to the main view" goes on the right. Toggled panes use F9, and they "overlap the main view when there isn't available width." [O]
- **Implication.** Principles 7 and 8. All three platforms reserve a switcher for a few peer views and use panes, with independent toggles and shortcuts, for supporting tools. A header switcher that changes the main view matches the convention only if its views are true peers that aren't needed together.

### Progressive disclosure

- Nielsen (NN/g, 2006): progressive disclosure "defers advanced or rarely used features to a secondary screen"; "You must get the right split between initial and secondary features," and "You have to disclose everything that users frequently need up front." He points to training-wheels research as support but the article itself is guidance. [O]
- Recognition over recall (Budiu, NN/g 2024): make "information and interface functions visible and easily accessible." [O, grounded in memory research]
- **Implication.** Principle 8. Thread status and Approvals are frequent and urgent, so they belong in the visible, primary set.

## Baseline observations

These come from reading `main` at 6839a1e. They illustrate the tests and aren't a prototype verdict.

- The sidebar with status dots stays visible in every Work mode (`web/src/App.tsx`, `styles.css` `.status-dot.needs-input`), so the baseline partly passes principle 1. A dot alone may not meet "reachable in one action" for the Approval itself; check this in prototypes.
- Terminal appears in two places, the bottom Surface and Terminal Work mode. Its header toggle is hidden in Terminal mode (`hidden={workMode === "terminal"}`), and both are keyed to (Project, Thread). This is the case principle 4 asks to resolve.
- Ctrl+N / ⌘N means "new Thread" globally (`web/src/shortcuts.ts`) but "new file" in Code (`docs/workbench.md`, `web/src/CodeWorkbench.tsx`). This is the mode-dependent shortcut that principle 6(c) flags.
- Previous/next Thread (Mod+↑/↓) and the Board shortcut force the Work mode back to Chat (`setWorkMode("chat")` in `web/src/App.tsx`). Moving between Threads therefore also changes the view, which principles 3 and 4 test.
- `workspaceLayout` in `web/src/panelLayout.ts` sets sidebar min 208 px, Tools min 496 px and centre min 360 px. At 900 px width with Tools open, the arithmetic leaves 196 px for the centre, below its own floor. Principle 8's collapse order needs to decide what yields.

## Evidence limits

- **No direct study.** Nothing found compares Work modes with docked panels, or studies supervising several coding agents at once. Principles 1, 2 and 5 extrapolate from task-resumption and window-management studies to agent supervision.
- **Small and old samples.** Ko et al. analysed 10 developers in Eclipse 2.1; Piorkowski et al. 9; Kandogan and Shneiderman 12. Iqbal and Horvitz is correlational field data from 27 users. Sellen et al. studied vi-style key modes, not view modes.
- **Second-hand sources.** Raskin's book wasn't read directly. His definitions come from the Raskin Center's summary and secondary references, so they are paraphrased, not quoted from the book. Tesler is quoted from his 2012 *interactions* article, through a PDF copy. For Bly and Rosenberg (1986) and Code Bubbles (2010), only abstracts and summaries were checked. The CommandMaps finding comes from the authors' abstract.
- **Guidance isn't evidence.** NN/g articles and the three platform guides are expert convention. They matter for platform fit and user expectation, but they report no studies.
- **Unknown.** Which pairs of Oxide views are co-used in practice, and how often. The principle 5 list is a hypothesis drawn from Oxide's workflows; prototype sessions should confirm or prune it.

## Primary sources

**Empirical**

- Iqbal, S. T., & Horvitz, E. (2007). Disruption and recovery of computing tasks: field study, analysis, and directions. CHI '07. [PDF](https://www.erichorvitz.com/CHI_2007_Iqbal_Horvitz.pdf)
- Parnin, C., & Rugaber, S. (2011). Resumption strategies for interrupted programming tasks. *Software Quality Journal*, 19(1). [Preprint](https://sites.cc.gatech.edu/reverse/repository/resumptionstrategies.pdf)
- Ko, A. J., Myers, B. A., Coblenz, M. J., & Aung, H. H. (2006). An exploratory study of how developers seek, relate, and collect relevant information during software maintenance tasks. *IEEE TSE*, 32(12), 971–987. [PDF](https://faculty.washington.edu/ajko/papers/Ko2006SeekRelateCollect.pdf)
- Piorkowski, D. J., et al. (2013). The whats and hows of programmers' foraging diets. CHI '13. [Record](https://digitalcommons.memphis.edu/facpubs/3264), doi:10.1145/2470654.2466418
- Bragdon, A., et al. (2010). Code Bubbles: a working set-based interface for code understanding and maintenance. CHI '10. [PDF](https://www.eecs.ucf.edu/~jjl/pubs/p2503-bragdon.pdf)
- Scarr, J., Cockburn, A., Gutwin, C., & Bunt, A. (2012). Improving command selection with CommandMaps. CHI '12. [Abstract](https://hci.cs.umanitoba.ca/publications/details/improving-command-selection-with-commandmaps)
- Scarr, J., Cockburn, A., & Gutwin, C. (2012). Supporting and exploiting spatial memory in user interfaces. *Foundations and Trends in HCI*, 6(1). doi:10.1561/1100000046
- Gutwin, C., Van Der Kamp, M., Storring, J., Cockburn, A., & Phillips, C. (2020). Testing the limits of the spatial approach: comparing retrieval and revisitation performance of spatial and paged data organizations for large item sets. Graphics Interface 2020. [PDF](https://graphicsinterface.org/wp-content/uploads/gi2020-22.pdf)
- Findlater, L., & McGrenere, J. (2004). A comparison of static, adaptive, and adaptable menus. CHI '04. [PDF](https://www.cs.ubc.ca/labs/edapt/papers/findlater2004.pdf)
- Kandogan, E., & Shneiderman, B. (1997). Elastic Windows: evaluation of multi-window operations. CHI '97. [Paper](https://chi1997.acm.org/proceedings/paper/ek.html)
- Bly, S. A., & Rosenberg, J. K. (1986). A comparison of tiled and overlapping windows. CHI '86, 101–106. doi:10.1145/22627.22356 (abstract only)
- Sellen, A. J., Kurtenbach, G. P., & Buxton, W. A. S. (1992). The prevention of mode errors through sensory feedback. *Human-Computer Interaction*, 7(2), 141–164. [Summary and abstract](https://billbuxton.com/ModeErrors.html)

**Expert opinion and platform guidance**

- Tesler, L. (2012). A personal history of modeless text editing and cut/copy-paste. *interactions*, 19(4), 70–75. [ACM](https://interactions.acm.org/archive/view/july-august-2012/a-personal-history-of-modeless-text-editing-and-cut-copy-paste)
- Raskin, J. (2000). *The Humane Interface*. Addison-Wesley. Principles as summarized by the [Raskin Center](https://www.raskincenter.org/rchi/core-principles).
- Laubheimer, P. (2019). [Modes in user interfaces: when they help and when they hurt users](https://www.nngroup.com/articles/modes/). NN/g.
- Harley, A. (2018). [Visibility of system status](https://www.nngroup.com/articles/visibility-system-status/). NN/g.
- Budiu, R. (2024). [Memory recognition and recall in user interfaces](https://www.nngroup.com/articles/recognition-and-recall/). NN/g.
- Nielsen, J. (2006). [Progressive disclosure](https://www.nngroup.com/articles/progressive-disclosure/). NN/g.
- Apple Human Interface Guidelines: [Segmented controls](https://developer.apple.com/design/human-interface-guidelines/segmented-controls), [Split views](https://developer.apple.com/design/human-interface-guidelines/split-views), [Sidebars](https://developer.apple.com/design/human-interface-guidelines/sidebars).
- Microsoft Learn, Windows apps: [Navigation basics](https://learn.microsoft.com/en-us/windows/apps/design/basics/navigation-basics), [Split view](https://learn.microsoft.com/en-us/windows/apps/design/controls/split-view), [NavigationView](https://learn.microsoft.com/en-us/windows/apps/design/controls/navigationview).
- GNOME Human Interface Guidelines: [View switchers](https://developer.gnome.org/hig/patterns/nav/view-switchers.html), [Utility panes](https://developer.gnome.org/hig/patterns/containers/utility-panes.html).
