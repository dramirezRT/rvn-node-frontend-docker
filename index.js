const express = require('express')
const { exec } = require('child_process')

const app = express()

const PORT = 8080

app.get('/', (req, res) => {
    exec("cat /home/kingofthenorth/bootstrap-status.log && raven_status", (error, stdout, stderr) => {
    // exec("ls -lha && echo '' && ls /", (error, stdout, stderr) => {
        if (error) {
            console.log(`error: ${error.message}`);
            return;
        }
        if (stderr) {
            console.log(`stderr: ${stderr}`);
            return;
        }
        result = ""
        out = stdout.split('\n').forEach( (element) => {
            result = result + "<div>" + element + "</div>"
        })
        res.send(result)
        // console.log(result);
    });
})

app.listen(PORT, () => {
    console.log(`Server running on port: ${PORT}`)
})