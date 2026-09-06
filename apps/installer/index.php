<?php
// Pathshala installer entry: Apache serves index.php before any .htaccess exists, so the very first
// visit to the domain lands here and runs the bootstrap. Removed together with install.php when setup completes.
require __DIR__ . '/install.php';
