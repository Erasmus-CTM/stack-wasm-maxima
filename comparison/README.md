# Public Quarto comparison

This standalone report presents the accepted milestone 2 comparison. Its results are deliberately tied to run `39721228518`, rather than whichever run happens to be latest.

Render with Quarto 1.8.27 from the repository root:

```sh
quarto render comparison/index.qmd
```

The self-contained `comparison/index.html` embeds its CSS and the two committed screenshots. Its links open the actual SymPy and hybrid Maxima exercise pages. The rendered file is ignored by Git and preserved by the comparison workflow artifact. The interactive demo build remains in `scripts/milestone-two/`.

Public publication uses `scripts/public-demo/package.py` to combine the accepted demo artifact with the rendered comparison at `dist/index.html`. The SymPy and Maxima exercise pages, workers, question sources and runtime assets are served together. `comparison/_headers` enables cross-origin isolation on the public static host. The package records every public file's hash and the original artifact provenance. The Quarto source and evidence remain in this repository. Rebuild and publish explicitly when the report changes; rendering CI does not silently replace the accepted measurements or deploy a new version.

```sh
python scripts/public-demo/package.py --accepted-artifact /path/to/milestone-two-accepted.zip --comparison-html comparison/index.html --output /path/to/publish/dist
```
