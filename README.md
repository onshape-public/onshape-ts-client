#### Description
Sample Onshape API workflow examples in typescript

#### Requirements
Git, Nodejs and Npm should be installed. **credentials.json** should be populated

#### Building
Clone this github repo locally and run the below command to install all the dependencies and do a build

    $ npm run build

#### Folder processor example
First ensure you have valid **credentials.json** and run it like below

    $ npm run processfolder aa8e16d5387740ee4bacad61

This application will process a folder recursively and generate of report of all documents residing in it.
Here **aa8e16d5387740ee4bacad61** is the onshape id of the the folder. You can get this id by navigating to the folder
in the webclient like so

    $  https://cad.onshape.com/documents?nodeId=aa8e16d5387740ee4bacad61&resourceType=folder

What the **Folder processor** does

* Find all documents and sub folders in the specified folder
    * For each document process all of its workspaces
        * For each workspace find all externally linked documents used in it
* Generate **references.csv** report contain all documents involved and whether any of them are not contained in the folder.

| DocumentId | DocumentName | Description | FolderId | FolderName | Outside
| ------------- | ------------- | ------------- | ------------- | ------------- | ------------- |
| 9dccef50cd7a57d15eee4f1e  | doc1  | gear | aa8e16d5387740ee4bacad61 | folder1 | No
| 6fcc8db39175774e7ce064ad  | doc2  | casting |  |  | Yes


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