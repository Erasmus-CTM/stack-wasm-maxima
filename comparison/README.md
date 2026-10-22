# Public Quarto comparison

This standalone report presents the accepted milestone 2 comparison. Its results are deliberately tied to run `39721228518`, rather than whichever run happens to be latest.

Render with Quarto 1.8.27 from the repository root:

```sh
quarto render comparison/index.qmd
```

The self-contained `comparison/index.html` embeds its CSS and the two committed screenshots. It needs no CAS runtime, isolation headers or external assets. The rendered file is ignored by Git and preserved by the comparison workflow artifact. The interactive demo build remains in `scripts/milestone-two/` and requires the documented isolation-header server.

Public publication uses the rendered HTML as the static `dist/index.html` of the Sites project. The Quarto source and evidence remain in this repository. Rebuild and publish explicitly when the report changes; rendering CI does not silently replace the accepted measurements or deploy a new version.
