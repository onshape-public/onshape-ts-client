#### Description
Sample Onshape API workflow examples in typescript

#### Requirements
Git, Nodejs and Npm should be installed. **credentials.json** should be populated

#### Building
Clone this github repo locally and run the below command to install all the dependencies and do a build first

    $ npm run build

----------------------------------------------------------------------------------------------------
# Examples section

Listed are the various workflows samples included in this repo. All examples make **Onshape API** calls
and need a valid **credentials.json**.  Please refer to **Storing credentials** section down below.

## Folder processor example
    $ npm run processfolder  --folder=aa8e16d5387740ee4bacad61

This application will process a folder recursively and generate of report of all documents residing in it.
Here **aa8e16d5387740ee4bacad61** is the onshape id of the folder. You can get this id by navigating to the folder
in the webclient like so

    $  https://cad.onshape.com/documents?nodeId=aa8e16d5387740ee4bacad61&resourceType=folder

What the **Folder processor** does

* Find all documents and sub folders in the specified folder
    * For each document process all of its workspaces
        * For each workspace find all externally linked documents used in it
* Generate **references.csv** report containing all documents involved and whether any of them are not contained in the folder.

| DocumentId | DocumentName | Description | FolderId | FolderName | Outside
| ------------- | ------------- | ------------- | ------------- | ------------- | ------------- |
| 9dccef50cd7a57d15eee4f1e  | doc1  | gear | aa8e16d5387740ee4bacad61 | folder1 | No
| 6fcc8db39175774e7ce064ad  | doc2  | casting |  |  | Yes

----------------------------------------------------------------------------------------------------

## Find Revisions example
    $ npm run findrevisions                           # to find only the latest revsions
    $ npm run findrevisions  --all                    # to find all revisions

The script will generate **revisions.csv** that will contain all part numbers and their revisions ever released in your company. The API Key must be generated for a company admin as only they can enumerate all revisions. 

----------------------------------------------------------------------------------------------------

## Programmatic Revision Creation

This is will create a release package for specified version and elementId and do a release. For
the release to be successful part numbers must be pre-assigned to all items.

    $ npm run createrevision  --docuri='https://cad.onshape.com/documents/9f4add5034da1df0c2d028e5/v/4e858b7f13995eac3612aca6/e/d71a3248320c779e3d24ac48'

###### Supported options
> ---docuri='https://cad.onshape.com/documents/9f4add5034da1df0c2d028e5/v/4e858b7f13995eac3612aca6/e/d71a3248320c779e3d24ac48'

This parameter is required and you need to have WRITE access to release the element.

> ---pid='JHD' 

If you are releasing a part you will also need to specify its id.

> --configuration='XXX' 

The right configuration for the assembly/part studio. This can also be part of the docuri search paramrs

> --revision=F 

By default the next valid revision will be used. You can use this option to skip revisions.

> --partnumber=PNO

Use if part number is not already set in workspace or version, you can specify the part number for the item to release.

> --releasename='RevARelease'

If you a releasing an existing version, its name is used. Otherwise you can specify the **name** of the release package.


----------------------------------------------------------------------------------------------------

#### Storing credentials in *credentials.json*
This sample expects api keys to make onshape api calls.  Use dev portal to generate api keys as a company admin and
save in this format in the same folder as **credentials.json** 

    {
        "cad": {
            "url": "https://cad.onshape.com/",
            "accessKey": "XXXXXXXXXXXXXXX",
            "secretKey": "YYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY"
        }
    }

#### Logging

The application logs both to console and a file called main.log. Both of these can be configured by **utils/logger.ts**
Refer to [log4js](https://log4js-node.github.io/log4js-node/) for additional logging configurations


#### Additional information

The credentials file can store multiple api keys. For all of the scripts you can specify an extra argument 

>  --stack=cad 

as needed to pick the right credentials.

If you are member of multiple companies you can specify an extra argument

>  --companyId=XXXX

to pick the right company Id. You can also save it as a **companyId** field in your credentials.json

#### Editing in Visual Studio Code

To customize any of these scripts or add additional ones, using **Visual Studio Code** IDE is highly recommended. 

1. Style and eslint settings are preconfigured for Visual Studio Code workspace.
2. Debugging various scripts are already setup in **lauch.json**
3. Simply pick **Tasks: Run Build Task** -> **tsc: watch** to ensure the javascript files are compiled on edit for debugging
