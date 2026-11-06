<?php
// Logo block of the sign-in style pages: customisable name and logo, the product name is always shown below it.
$name = \WebManager\Support\Brand::name();
?>
<div class="logo"><img src="<?= e(\WebManager\Support\Brand::logoUrl()) ?>" alt="<?= e($name) ?>"><span><b><?= e($name) ?></b><small><?= e(\WebManager\Support\Brand::PRODUCT) ?></small></span></div>
