Now, we want to check all scripts for creating salesforce manifest for any changes on github pull requests or push.

1. We need an input to be passed to be boolean, and it will copy all the files into a new folder of a new artificat for this new changes. and will copy sfdx-porject.json into the artifact folder as well. By default it is truem but if it is false, it will just create the manifest.

2. It can create a docker image of all new changes as well. (with sfdx-project.json)

3. The new diff will check if the new changes is on bundle components of salesforce ( like LWC, Aura, ...), then it will check if the main files of bundles removed, then it is a removed bundle, otherwise it is just a change on a bundle and should be considered as new changes.

4. If we have changes on custom label, or sharingRules, it should find between the previous version ( on baseRef commit), and find the new changes. ( to not bring all the changes to the play again.)
