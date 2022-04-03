# Dawn, the multistage release semantic versioning action

Used for:
- Merging the code needed for the release
- Getting the reference to the commit meant for the release
- Generating the release's semantic version information
- Extracting the previous release's version information for the change log generation

Usage:
```yaml
    steps:
      - uses: NoorDigitalAgency/dawn@main
        id: dawn
        name: Dawn
        with:
          stage: 'alpha' # What stage is the release targeting (alpha, beta and production)
          reference: '' # If the release's source is anything other than the previous stage's latest release
          hotfix: flase # If it is a hotfix release (stage must be production)
          token: ${{ secrets.pat }} # Private access token with read and write access to the repository
          exports: true # If true, the outputs will be exported as environment variables
          artifact: true # If true, the outputs will be exported as an artifact
      - uses: actions/checkout@v2
        name: Checkout
        with:
          ref: ${{ env.DAWN_REFERENCE }}
          submodules: 'recursive'
```
